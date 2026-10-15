package main

// Public REST API (/api/v1), documented in docs/API.md. It is off until enabled in the
// settings, accepts only API tokens (never the session cookie, so it cannot be abused
// through CSRF) and every token is limited to the scopes chosen at creation.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var apiScopes = map[string]string{
	"status:read":       "État global et page de statut",
	"hosts:read":        "Hôtes et dernières mesures",
	"hosts:write":       "Enregistrer un hôte et obtenir son jeton d'agent (déploiement automatisé, Ansible)",
	"metrics:read":      "Historique des métriques des hôtes",
	"monitors:read":     "Sondes, disponibilité et latence",
	"updates:read":      "Mises à jour en attente",
	"smart:read":        "Santé des disques (SMART)",
	"docker:read":       "Conteneurs Docker et mises à jour d'images",
	"reports:read":      "Rapports mensuels",
	"maintenance:write": "Activer ou désactiver la maintenance d'un hôte ou d'une sonde",
}

const tokenPrefix = "hlm_"

type APIToken struct {
	ID         int64    `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"` // first characters, to recognise a token without storing it
	Scopes     []string `json:"scopes"`
	ExpiresAt  *int64   `json:"expires_at"`
	CreatedAt  int64    `json:"created_at"`
	LastUsedAt int64    `json:"last_used_at"`
}

type tokenCtxKey struct{}

var apiLimiter = newRateLimiter(600, time.Minute)

// lastUsed throttles last_used_at writes to one per token per minute.
var lastUsed sync.Map

func (s *Server) apiRoutes(mux *http.ServeMux) {
	t := s.requireToken
	mux.HandleFunc("OPTIONS /api/v1/", s.handleAPIPreflight)
	mux.HandleFunc("GET /api/v1/status", t("status:read", s.apiStatus))
	mux.HandleFunc("GET /api/v1/hosts", t("hosts:read", s.handleListHosts))
	mux.HandleFunc("POST /api/v1/hosts", t("hosts:write", s.apiRegisterHost))
	mux.HandleFunc("GET /api/v1/hosts/{id}", t("hosts:read", s.handleGetHost))
	mux.HandleFunc("GET /api/v1/hosts/{id}/metrics", t("metrics:read", s.handleHostMetrics))
	mux.HandleFunc("PUT /api/v1/hosts/{id}/maintenance", t("maintenance:write", s.apiHostMaintenance))
	mux.HandleFunc("GET /api/v1/monitors", t("monitors:read", s.handleListMonitors))
	mux.HandleFunc("GET /api/v1/monitors/{id}", t("monitors:read", s.handleGetMonitor))
	mux.HandleFunc("GET /api/v1/monitors/{id}/results", t("monitors:read", s.handleMonitorResults))
	mux.HandleFunc("PUT /api/v1/monitors/{id}/maintenance", t("maintenance:write", s.apiMonitorMaintenance))
	mux.HandleFunc("GET /api/v1/updates", t("updates:read", s.apiUpdates))
	mux.HandleFunc("GET /api/v1/disks", t("smart:read", s.handleDisks))
	mux.HandleFunc("GET /api/v1/containers", t("docker:read", s.handleContainers))
	mux.HandleFunc("GET /api/v1/reports/monthly", t("reports:read", s.handleMonthlyReport))
	mux.HandleFunc("GET /api/v1/reports/energy", t("reports:read", s.handleEnergyReport))
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) { writeErr(w, 404, "Route inconnue") })

	auth := s.requireAuth
	mux.HandleFunc("GET /api/tokens", auth(s.handleListTokens))
	mux.HandleFunc("POST /api/tokens", auth(s.handleCreateToken))
	mux.HandleFunc("DELETE /api/tokens/{id}", auth(s.handleDeleteToken))
}

// corsAllowed reports whether a browser on this origin may call the API (setting api_cors_origins).
func (s *Server) corsAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	for _, o := range strings.Split(s.getSetting("api_cors_origins", ""), ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" && strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); s.corsAllowed(o) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", o)
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		h.Set("Access-Control-Max-Age", "600")
		h.Add("Vary", "Origin")
	}
}

func (s *Server) handleAPIPreflight(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requireToken(scope string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.setCORS(w, r)
		if s.getSetting("api_enabled", "false") != "true" {
			writeErr(w, 404, "L'API est désactivée (Réglages → API)")
			return
		}
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !strings.HasPrefix(tok, tokenPrefix) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="hlm"`)
			writeErr(w, 401, "Jeton API manquant : en-tête Authorization: Bearer hlm_…")
			return
		}
		var id int64
		var scopes string
		var exp sql.NullInt64
		err := s.db.QueryRow(`SELECT id, scopes, expires_at FROM api_tokens WHERE token_hash=?`, hashToken(tok)).Scan(&id, &scopes, &exp)
		if err != nil {
			if !s.limiter.allow("api:" + s.clientIP(r)) {
				writeErr(w, 429, "Trop de tentatives")
				return
			}
			writeErr(w, 401, "Jeton API invalide ou révoqué")
			return
		}
		if exp.Valid && time.Now().Unix() >= exp.Int64 {
			writeErr(w, 401, "Jeton API expiré")
			return
		}
		if !slices.Contains(strings.Split(scopes, ","), scope) {
			writeErr(w, 403, "Ce jeton n'a pas le scope "+scope)
			return
		}
		if !apiLimiter.allow(strconv.FormatInt(id, 10)) {
			w.Header().Set("Retry-After", "60")
			writeErr(w, 429, "Limite de 600 requêtes par minute atteinte")
			return
		}
		now := time.Now().Unix()
		if prev, _ := lastUsed.Load(id); prev == nil || now-prev.(int64) >= 60 {
			lastUsed.Store(id, now)
			s.db.Exec(`UPDATE api_tokens SET last_used_at=? WHERE id=?`, now, id)
		}
		h(w, r.WithContext(context.WithValue(r.Context(), tokenCtxKey{}, id)))
	}
}

func (s *Server) apiStatus(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	mons, err := s.loadMonitors("WHERE enabled=1")
	if err != nil {
		serverErr(w, err)
		return
	}
	count := func(statuses []string) map[string]int {
		c := map[string]int{}
		for _, st := range statuses {
			c[st]++
		}
		return c
	}
	var hs, ms []string
	for _, h := range hosts {
		hs = append(hs, h.Status)
	}
	for _, m := range mons {
		ms = append(ms, m.Status)
	}
	writeJSON(w, 200, map[string]any{
		"status":   overallStatus(append(slices.Clone(hs), ms...)),
		"hosts":    map[string]any{"total": len(hosts), "by_status": count(hs)},
		"monitors": map[string]any{"total": len(mons), "by_status": count(ms)},
		"time":     time.Now().Unix(),
	})
}

func (s *Server) apiUpdates(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	type row struct {
		HostID  int64         `json:"host_id"`
		Host    string        `json:"host"`
		Updates *agentUpdates `json:"updates"`
	}
	out := []row{}
	for _, h := range hosts {
		out = append(out, row{h.ID, h.Name, h.Updates})
	}
	writeJSON(w, 200, out)
}

// apiRegisterHost creates a host and returns its agent credentials, for unattended deployment.
// With rotate_if_exists, an existing host of the same name gets a new token instead (re-installs).
func (s *Server) apiRegisterHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name           string `json:"name"`
		RotateIfExists bool   `json:"rotate_if_exists"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, msg := validName(req.Name)
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	tok := randomToken(32)
	var id int64
	err := s.db.QueryRow(`SELECT id FROM hosts WHERE name=? ORDER BY id LIMIT 1`, name).Scan(&id)
	switch {
	case err == nil && !req.RotateIfExists:
		writeErr(w, 409, "Un hôte porte déjà ce nom (rotate_if_exists: true pour lui attribuer un nouveau jeton)")
		return
	case err == nil:
		if _, err := s.db.Exec(`UPDATE hosts SET token_hash=? WHERE id=?`, hashToken(tok), id); err != nil {
			serverErr(w, err)
			return
		}
		s.dropAgent(id)
		writeJSON(w, 200, map[string]any{"id": id, "name": name, "created": false, "install": s.installInfo(r, tok)})
	case errors.Is(err, sql.ErrNoRows):
		res, err := s.db.Exec(`INSERT INTO hosts(name,token_hash,created_at) VALUES(?,?,?)`, name, hashToken(tok), time.Now().Unix())
		if err != nil {
			serverErr(w, err)
			return
		}
		id, _ = res.LastInsertId()
		writeJSON(w, 201, map[string]any{"id": id, "name": name, "created": true, "install": s.installInfo(r, tok)})
	default:
		serverErr(w, err)
	}
}

func (s *Server) setMaintenance(w http.ResponseWriter, r *http.Request, table string) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req struct {
		Maintenance *bool `json:"maintenance"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Maintenance == nil {
		writeErr(w, 400, "Le champ maintenance (true ou false) est requis")
		return
	}
	res, err := s.db.Exec(`UPDATE `+table+` SET maintenance=? WHERE id=?`, *req.Maintenance, id)
	if err != nil {
		serverErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 404, "Élément introuvable")
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "maintenance": *req.Maintenance})
}

func (s *Server) apiHostMaintenance(w http.ResponseWriter, r *http.Request) {
	s.setMaintenance(w, r, "hosts")
}

func (s *Server) apiMonitorMaintenance(w http.ResponseWriter, r *http.Request) {
	s.setMaintenance(w, r, "monitors")
}

/* ---------- Token management (dashboard, session-authenticated) ---------- */

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id,name,prefix,scopes,expires_at,created_at,last_used_at FROM api_tokens ORDER BY created_at DESC`)
	if err != nil {
		serverErr(w, err)
		return
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		var scopes string
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &scopes, &t.ExpiresAt, &t.CreatedAt, &t.LastUsedAt); err != nil {
			serverErr(w, err)
			return
		}
		t.Scopes = strings.Split(scopes, ",")
		out = append(out, t)
	}
	writeJSON(w, 200, map[string]any{"tokens": out, "scopes": apiScopes})
}

func validateTokenRequest(name string, scopes []string, expiresAt *int64) (string, string) {
	name, msg := validName(name)
	if msg != "" {
		return "", msg
	}
	if len(scopes) == 0 {
		return "", "Choisissez au moins un scope"
	}
	for _, sc := range scopes {
		if _, ok := apiScopes[sc]; !ok {
			return "", "Scope inconnu : " + sc
		}
	}
	if expiresAt != nil {
		now := time.Now()
		if *expiresAt <= now.Unix() {
			return "", "La date d'expiration doit être dans le futur"
		}
		if *expiresAt > now.AddDate(5, 0, 0).Unix() {
			return "", "La date d'expiration doit être à moins de 5 ans"
		}
	}
	return name, ""
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		ExpiresAt *int64   `json:"expires_at"` // unix seconds, null = never
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, msg := validateTokenRequest(req.Name, req.Scopes, req.ExpiresAt)
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	slices.Sort(req.Scopes)
	req.Scopes = slices.Compact(req.Scopes)
	tok := tokenPrefix + randomToken(32)
	res, err := s.db.Exec(`INSERT INTO api_tokens(name,token_hash,prefix,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?)`,
		name, hashToken(tok), tok[:len(tokenPrefix)+6], strings.Join(req.Scopes, ","), req.ExpiresAt, time.Now().Unix())
	if err != nil {
		serverErr(w, err)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, 201, map[string]any{"id": id, "token": tok})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	res, err := s.db.Exec(`DELETE FROM api_tokens WHERE id=?`, id)
	if err != nil {
		serverErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 404, "Jeton introuvable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
