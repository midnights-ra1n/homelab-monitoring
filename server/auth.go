package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	sessionCookie = "hlm_session"
	sessionTTL    = 7 * 24 * time.Hour
)

type ctxKey struct{}

func randomToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) []byte {
	h := sha256.Sum256([]byte(t))
	return h[:]
}

// Argon2id with OWASP-recommended parameters (19 MiB, 2 passes).
func hashPassword(pw string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	key := argon2.IDKey([]byte(pw), salt, 2, 19*1024, 1, 32)
	return fmt.Sprintf("argon2id$%s$%s", hex.EncodeToString(salt), hex.EncodeToString(key))
}

func checkPassword(hash, pw string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 3 || parts[0] != "argon2id" {
		return false
	}
	salt, err1 := hex.DecodeString(parts[1])
	want, err2 := hex.DecodeString(parts[2])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, 2, 19*1024, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash makes a login for an unknown user cost the same as a real one.
var dummyHash = hashPassword("timing-equaliser")

func validPassword(pw string) string {
	if utf8.RuneCountInString(pw) < 12 {
		return "Le mot de passe doit contenir au moins 12 caractères"
	}
	if len(pw) > 256 {
		return "Le mot de passe doit contenir au plus 256 caractères"
	}
	return ""
}

func (s *Server) initSetup() error {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	s.setupOpen = n == 0
	if s.setupOpen {
		slog.Warn("no account yet: open the web UI to create the administrator account")
	}
	return nil
}

func (s *Server) currentUser(r *http.Request) (int64, string, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0, "", false
	}
	var id int64
	var name string
	err = s.db.QueryRow(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.token_hash=? AND s.expires_at>?`, hashToken(c.Value), time.Now().Unix()).Scan(&id, &name)
	return id, name, err == nil
}

func (s *Server) requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _, ok := s.currentUser(r)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "Connexion requise")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	}
}

func (s *Server) handleAuthState(w http.ResponseWriter, r *http.Request) {
	s.setupMu.Lock()
	setup := s.setupOpen
	s.setupMu.Unlock()
	_, name, ok := s.currentUser(r)
	writeJSON(w, 200, map[string]any{"setup_required": setup, "authenticated": ok, "username": name, "version": version, "dev_mode": devMode})
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("login:" + s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "Trop de tentatives, réessayez dans une minute")
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if !s.setupOpen {
		writeErr(w, http.StatusConflict, "Le compte administrateur existe déjà")
		return
	}
	c.Username = strings.TrimSpace(c.Username)
	if c.Username == "" || len(c.Username) > 64 {
		writeErr(w, 400, "Le nom d'utilisateur doit contenir entre 1 et 64 caractères")
		return
	}
	if msg := validPassword(c.Password); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	res, err := s.db.Exec(`INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)`, c.Username, hashPassword(c.Password), time.Now().Unix())
	if err != nil {
		serverErr(w, err)
		return
	}
	s.setupOpen = false
	id, _ := res.LastInsertId()
	s.startSession(w, r, id)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("login:" + s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "Trop de tentatives, réessayez dans une minute")
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	var id int64
	var hash string
	if err := s.db.QueryRow(`SELECT id, password_hash FROM users WHERE username=?`, strings.TrimSpace(c.Username)).Scan(&id, &hash); err != nil {
		checkPassword(dummyHash, c.Password)
		writeErr(w, http.StatusUnauthorized, "Identifiant ou mot de passe incorrect")
		return
	}
	if !checkPassword(hash, c.Password) {
		slog.Warn("failed login", "user", c.Username, "ip", s.clientIP(r))
		writeErr(w, http.StatusUnauthorized, "Identifiant ou mot de passe incorrect")
		return
	}
	s.startSession(w, r, id)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID int64) {
	tok := randomToken(32)
	exp := time.Now().Add(sessionTTL)
	if _, err := s.db.Exec(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)`, hashToken(tok), userID, exp.Unix()); err != nil {
		serverErr(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: tok, Path: "/", Expires: exp,
		HttpOnly: true, Secure: s.isHTTPS(r), SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.isHTTPS(r), SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	uid := r.Context().Value(ctxKey{}).(int64)
	var hash string
	if err := s.db.QueryRow(`SELECT password_hash FROM users WHERE id=?`, uid).Scan(&hash); err != nil || !checkPassword(hash, req.Current) {
		writeErr(w, http.StatusForbidden, "Le mot de passe actuel est incorrect")
		return
	}
	if msg := validPassword(req.New); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	// Changing the password signs out every other session.
	c, _ := r.Cookie(sessionCookie)
	tx, err := s.db.Begin()
	if err != nil {
		serverErr(w, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET password_hash=? WHERE id=?`, hashPassword(req.New), uid); err != nil {
		serverErr(w, err)
		return
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=? AND token_hash<>?`, uid, hashToken(c.Value)); err != nil {
		serverErr(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
