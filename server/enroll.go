package main

// Shared enrollment tokens (like Beszel's universal token): every machine can be installed
// with the same TOKEN and KEY. On its first connection an agent presenting an enrollment
// token gets a new host and its own agent token, which it stores and uses from then on.
// An enrollment token can therefore only create hosts, never act as an existing one.

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const enrollPrefix = "enr_"

type EnrollToken struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	ExpiresAt  *int64 `json:"expires_at"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at"`
	Uses       int    `json:"uses"`
}

// enrollHost creates a host for an agent presenting a valid enrollment token.
// It returns the new host and its personal token, or ok=false if the token is not valid.
func (s *Server) enrollHost(tok, hostname string) (id int64, name, hostToken string, ok bool, err error) {
	var tid int64
	var exp sql.NullInt64
	err = s.db.QueryRow(`SELECT id, expires_at FROM enroll_tokens WHERE token_hash=?`, hashToken(tok)).Scan(&tid, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", "", false, nil
	}
	if err != nil || (exp.Valid && time.Now().Unix() >= exp.Int64) {
		return 0, "", "", false, err
	}
	name = cleanHostname(hostname)
	// Keep names unique so enrolled machines stay distinguishable: pve, pve-2, pve-3...
	base := name
	for i := 2; ; i++ {
		var n int
		if err = s.db.QueryRow(`SELECT COUNT(*) FROM hosts WHERE name=?`, name).Scan(&n); err != nil {
			return
		}
		if n == 0 {
			break
		}
		name = base + "-" + strconv.Itoa(i)
	}
	hostToken = randomToken(32)
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO hosts(name,token_hash,created_at) VALUES(?,?,?)`, name, hashToken(hostToken), time.Now().Unix())
	if err != nil {
		return
	}
	id, _ = res.LastInsertId()
	if _, err = tx.Exec(`UPDATE enroll_tokens SET uses=uses+1, last_used_at=? WHERE id=?`, time.Now().Unix(), tid); err != nil {
		return
	}
	return id, name, hostToken, true, tx.Commit()
}

// cleanHostname keeps a readable, bounded name from the agent-supplied hostname.
func cleanHostname(h string) string {
	h = strings.TrimSpace(strings.Split(h, ".")[0])
	h = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			return r
		}
		return -1
	}, h)
	if len(h) > 60 {
		h = h[:60]
	}
	if h == "" {
		h = "hote"
	}
	return h
}

func (s *Server) handleListEnrollTokens(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id,name,prefix,expires_at,created_at,last_used_at,uses FROM enroll_tokens ORDER BY created_at DESC`)
	if err != nil {
		serverErr(w, err)
		return
	}
	defer rows.Close()
	out := []EnrollToken{}
	for rows.Next() {
		var t EnrollToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.ExpiresAt, &t.CreatedAt, &t.LastUsedAt, &t.Uses); err != nil {
			serverErr(w, err)
			return
		}
		out = append(out, t)
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleCreateEnrollToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string `json:"name"`
		ExpiresAt *int64 `json:"expires_at"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, msg := validateTokenRequest(req.Name, []string{"status:read"}, req.ExpiresAt)
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	tok := enrollPrefix + randomToken(32)
	res, err := s.db.Exec(`INSERT INTO enroll_tokens(name,token_hash,prefix,expires_at,created_at) VALUES(?,?,?,?,?)`,
		name, hashToken(tok), tok[:len(enrollPrefix)+6], req.ExpiresAt, time.Now().Unix())
	if err != nil {
		serverErr(w, err)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, 201, map[string]any{"id": id, "install": s.installInfo(r, tok)})
}

func (s *Server) handleDeleteEnrollToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Exec(`DELETE FROM enroll_tokens WHERE id=?`, id); err != nil {
		serverErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
