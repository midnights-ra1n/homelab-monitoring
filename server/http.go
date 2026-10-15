package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	auth := s.requireAuth

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /api/auth/state", s.handleAuthState)
	mux.HandleFunc("POST /api/auth/setup", s.handleSetup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("POST /api/auth/password", auth(s.handleChangePassword))

	mux.HandleFunc("GET /api/agent/ws", s.handleAgentWS)
	mux.HandleFunc("GET /api/public/status", s.handlePublicStatus)

	mux.HandleFunc("GET /api/overview", auth(s.handleOverview))
	mux.HandleFunc("GET /api/hosts", auth(s.handleListHosts))
	mux.HandleFunc("POST /api/hosts", auth(s.handleCreateHost))
	mux.HandleFunc("GET /api/hosts/{id}", auth(s.handleGetHost))
	mux.HandleFunc("PATCH /api/hosts/{id}", auth(s.handleUpdateHost))
	mux.HandleFunc("DELETE /api/hosts/{id}", auth(s.handleDeleteHost))
	mux.HandleFunc("POST /api/hosts/{id}/token", auth(s.handleRotateHostToken))
	mux.HandleFunc("GET /api/hosts/{id}/metrics", auth(s.handleHostMetrics))
	mux.HandleFunc("POST /api/hosts/{id}/action", auth(s.handleHostAction))

	mux.HandleFunc("GET /api/monitors", auth(s.handleListMonitors))
	mux.HandleFunc("POST /api/monitors", auth(s.handleCreateMonitor))
	mux.HandleFunc("GET /api/monitors/{id}", auth(s.handleGetMonitor))
	mux.HandleFunc("PUT /api/monitors/{id}", auth(s.handleUpdateMonitor))
	mux.HandleFunc("DELETE /api/monitors/{id}", auth(s.handleDeleteMonitor))
	mux.HandleFunc("GET /api/monitors/{id}/results", auth(s.handleMonitorResults))

	mux.HandleFunc("GET /api/settings", auth(s.handleGetSettings))
	mux.HandleFunc("PUT /api/settings", auth(s.handlePutSettings))
	mux.HandleFunc("POST /api/settings/test-email", auth(s.handleTestEmail))
	mux.HandleFunc("POST /api/settings/preview-email", auth(s.handlePreviewEmail))
	mux.HandleFunc("POST /api/maintenance/vacuum", auth(s.handleVacuum))
	mux.HandleFunc("GET /api/export", auth(s.handleExport))
	mux.HandleFunc("POST /api/import", auth(s.handleImport))

	mux.HandleFunc("GET /api/disks", auth(s.handleDisks))
	mux.HandleFunc("GET /api/containers", auth(s.handleContainers))
	mux.HandleFunc("GET /api/reports/monthly", auth(s.handleMonthlyReport))
	mux.HandleFunc("POST /api/reports/monthly/send", auth(s.handleSendMonthlyReport))
	mux.HandleFunc("GET /api/reports/energy", auth(s.handleEnergyReport))
	mux.HandleFunc("GET /api/reports/energy.csv", auth(s.handleEnergyCSV))
	mux.HandleFunc("POST /api/reports/energy/send", auth(s.handleSendEnergyReport))
	mux.HandleFunc("POST /api/meross/login", auth(s.handleMerossLogin))
	mux.HandleFunc("DELETE /api/meross", auth(func(w http.ResponseWriter, r *http.Request) {
		if err := s.setSetting("meross_key", ""); err != nil {
			serverErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /api/status/layout", auth(s.handleGetStatusLayout))
	mux.HandleFunc("PUT /api/status/layout", auth(s.handlePutStatusLayout))
	mux.HandleFunc("POST /api/status/preview", auth(s.handlePreviewStatus))
	mux.HandleFunc("GET /api/enroll-tokens", auth(s.handleListEnrollTokens))
	mux.HandleFunc("POST /api/enroll-tokens", auth(s.handleCreateEnrollToken))
	mux.HandleFunc("DELETE /api/enroll-tokens/{id}", auth(s.handleDeleteEnrollToken))
	s.apiRoutes(mux)

	mux.Handle("/", s.staticHandler())
	return s.securityHeaders(mux)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// Inline styles are needed by the chart library's DOM; scripts stay strictly same-origin.
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		if s.isHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
			// /api/v1 only accepts bearer tokens, never cookies, so it is not exposed to CSRF.
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions &&
				!strings.HasPrefix(r.URL.Path, "/api/v1/") && !s.sameOrigin(r) {
				writeErr(w, http.StatusForbidden, "Origine de la requête refusée")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin blocks cross-site state-changing requests (CSRF), on top of SameSite=Strict cookies.
func (s *Server) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		// Non-browser clients send no Origin; browsers always send it on cross-origin POST.
		return r.Header.Get("Sec-Fetch-Site") == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin"
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	// A cross-site page cannot choose the Host header, so Origin == Host proves same-origin.
	if s.cfg.PublicURL != "" {
		if pu, err := url.Parse(s.cfg.PublicURL); err == nil && strings.EqualFold(u.Host, pu.Host) && u.Scheme == pu.Scheme {
			return true
		}
	}
	return strings.EqualFold(u.Host, s.requestHost(r))
}

func (s *Server) trustedPeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	for _, n := range s.cfg.TrustedProxies {
		if ip != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP only honours X-Forwarded-For when the direct peer is a configured trusted proxy.
func (s *Server) clientIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if s.trustedPeer(r) {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(ip) != nil {
			return ip
		}
	}
	return host
}

func (s *Server) isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return s.trustedPeer(r) && r.Header.Get("X-Forwarded-Proto") == "https"
}

func (s *Server) requestHost(r *http.Request) string {
	if s.trustedPeer(r) {
		if h := r.Header.Get("X-Forwarded-Host"); h != "" {
			return h
		}
	}
	return r.Host
}

func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "http"
	if s.isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + s.requestHost(r)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func serverErr(w http.ResponseWriter, err error) {
	slog.Error("request failed", "err", err)
	writeErr(w, 500, "Erreur interne du serveur")
}

// readJSON decodes a size-limited JSON body and rejects unknown fields.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return readJSONLimit(w, r, v, 4<<20)
}

func readJSONLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeErr(w, http.StatusUnsupportedMediaType, "Le corps doit être du JSON")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "Le corps de la requête est trop volumineux")
		} else {
			writeErr(w, 400, "JSON invalide : "+err.Error())
		}
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, 400, "Identifiant invalide")
		return 0, false
	}
	return id, true
}

// rangeParam maps ?range= to a duration; unknown values fall back to 24h.
func rangeParam(r *http.Request) time.Duration {
	switch r.URL.Query().Get("range") {
	case "1h":
		return time.Hour
	case "6h":
		return 6 * time.Hour
	case "7d":
		return 7 * 24 * time.Hour
	case "30d":
		return 30 * 24 * time.Hour
	case "90d":
		return 90 * 24 * time.Hour
	}
	return 24 * time.Hour
}

// rateLimiter is a fixed-window counter per key (client IP), used for login and agent auth.
type rateLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func newRateLimiter(max int, w time.Duration) *rateLimiter {
	return &rateLimiter{max: max, window: w, hits: map[string]*window{}}
}

func (l *rateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 10000 { // bound memory under a spray of source addresses
		for k, w := range l.hits {
			if now.Sub(w.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) > l.window {
		l.hits[key] = &window{start: now, n: 1}
		return true
	}
	w.n++
	return w.n <= l.max
}
