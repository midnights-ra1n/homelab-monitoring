package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	db, err := openDB(dir)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := loadOrCreateKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{DataDir: dir}, db: db, priv: priv, pub: priv.Public().(ed25519.PublicKey),
		limiter: newRateLimiter(100, time.Minute), agents: map[int64]*agentConn{}}
	s.notifier = newNotifier(s)
	if err := s.initSetup(); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.routes())
	t.Cleanup(func() { ts.Close(); db.Close() })
	return s, ts
}

func do(t *testing.T, ts *httptest.Server, method, path, cookie string, body any) (*http.Response, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, ts.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", ts.URL)
	if cookie != "" {
		req.Header.Set("Cookie", sessionCookie+"="+cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func setupAdmin(t *testing.T, s *Server, ts *httptest.Server) string {
	t.Helper()
	resp, out := do(t, ts, "POST", "/api/auth/setup", "", credentials{Username: "admin", Password: "correct horse battery"})
	if resp.StatusCode != 200 {
		t.Fatalf("setup: %d %v", resp.StatusCode, out)
	}
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
				t.Fatal("session cookie must be HttpOnly + SameSite=Strict")
			}
			return c.Value
		}
	}
	t.Fatal("no session cookie")
	return ""
}

func TestSetupAndAuth(t *testing.T) {
	s, ts := newTestServer(t)
	if resp, _ := do(t, ts, "GET", "/api/hosts", "", nil); resp.StatusCode != 401 {
		t.Fatalf("unauthenticated access: %d", resp.StatusCode)
	}
	cookie := setupAdmin(t, s, ts)
	if resp, _ := do(t, ts, "POST", "/api/auth/setup", "", credentials{Username: "y", Password: "correct horse battery"}); resp.StatusCode != 409 {
		t.Fatalf("second setup must be refused: %d", resp.StatusCode)
	}
	if resp, _ := do(t, ts, "GET", "/api/hosts", cookie, nil); resp.StatusCode != 200 {
		t.Fatalf("authenticated access: %d", resp.StatusCode)
	}
	if resp, _ := do(t, ts, "POST", "/api/auth/login", "", credentials{Username: "admin", Password: "wrong password!!"}); resp.StatusCode != 401 {
		t.Fatalf("bad password: %d", resp.StatusCode)
	}
	if resp, _ := do(t, ts, "POST", "/api/auth/login", "", credentials{Username: "admin", Password: "correct horse battery"}); resp.StatusCode != 200 {
		t.Fatalf("login: %d", resp.StatusCode)
	}
}

func TestCrossOriginMutationBlocked(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	req, _ := http.NewRequest("POST", ts.URL+"/api/hosts", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Cookie", sessionCookie+"="+cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 403 {
		t.Fatalf("cross-origin POST: %d", resp.StatusCode)
	}
}

func TestAgentHandshakeAndMetrics(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	_, created := do(t, ts, "POST", "/api/hosts", cookie, map[string]string{"name": "pve-01"})
	install := created["install"].(map[string]any)
	token := install["token"].(string)
	pub, _ := base64.StdEncoding.DecodeString(install["key"].(string))

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/agent/ws"
	nonce := make([]byte, 32)
	rand.Read(nonce)
	hdr := http.Header{"Authorization": {"Bearer " + token}, "X-Agent-Nonce": {base64.StdEncoding.EncodeToString(nonce)}}

	// Unknown token is refused before the upgrade.
	bad := http.Header{"Authorization": {"Bearer " + strings.Repeat("a", 43)}, "X-Agent-Nonce": hdr["X-Agent-Nonce"]}
	if _, resp, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{HTTPHeader: bad}); err == nil || resp.StatusCode != 401 {
		t.Fatalf("unknown token must be refused")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var hello struct {
		Type     string `json:"type"`
		Sig      string `json:"sig"`
		Interval int    `json:"interval"`
	}
	if err := wsjson.Read(ctx, c, &hello); err != nil {
		t.Fatal(err)
	}
	sig, _ := base64.StdEncoding.DecodeString(hello.Sig)
	msg := append([]byte(agentAuthContext), nonce...)
	msg = append(msg, hashToken(token)...)
	if !ed25519.Verify(pub, msg, sig) {
		t.Fatal("hub signature does not verify with the advertised key")
	}
	wsjson.Write(ctx, c, agentMsg{Type: "info", Info: &agentInfo{Hostname: "pve-01", OS: "Debian 13"}})
	wsjson.Write(ctx, c, agentMsg{Type: "metrics", Metrics: &agentMetrics{CPU: 12.5, MemUsed: 1, MemTotal: 4, Disks: []agentDisk{{Mount: "/", Used: 1, Total: 2}}}})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		s.db.QueryRow(`SELECT COUNT(*) FROM host_metrics`).Scan(&n)
		if n == 1 {
			_, h := do(t, ts, "GET", "/api/hosts/1", cookie, nil)
			if h["status"] != StatusOperational || !h["connected"].(bool) {
				t.Fatalf("host status: %v", h)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("metrics were not stored")
}

func TestStatusMatcher(t *testing.T) {
	m, ok := statusMatcher("200-299, 301")
	if !ok || !m(204) || !m(301) || m(302) || m(500) {
		t.Fatal("matcher")
	}
	for _, bad := range []string{"", "abc", "300-200", "99", "200-700"} {
		if _, ok := statusMatcher(bad); ok {
			t.Fatalf("%q must be rejected", bad)
		}
	}
}

func TestHTTPAndTCPChecks(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail" {
			w.WriteHeader(503)
		}
		w.Write([]byte("hello world"))
	}))
	defer up.Close()
	cases := []struct {
		m    Monitor
		want string
	}{
		{Monitor{Name: "a", Type: "http", Target: up.URL}, StatusOperational},
		{Monitor{Name: "b", Type: "http", Target: up.URL + "/fail"}, StatusMinor},
		{Monitor{Name: "c", Type: "http", Target: up.URL, Config: MonitorConfig{Keyword: "absent"}}, StatusMinor},
		{Monitor{Name: "d", Type: "tcp", Target: strings.TrimPrefix(up.URL, "http://")}, StatusOperational},
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := l.Addr().String()
	l.Close()
	cases = append(cases, struct {
		m    Monitor
		want string
	}{Monitor{Name: "e", Type: "tcp", Target: closed}, StatusMajor})
	for _, c := range cases {
		if msg := c.m.validate(); msg != "" {
			t.Fatalf("%s: %s", c.m.Name, msg)
		}
		if got := runCheck(context.Background(), &c.m); got.status != c.want {
			t.Errorf("%s: got %s (%s), want %s", c.m.Name, got.status, got.message, c.want)
		}
	}
}

func TestMonitorValidation(t *testing.T) {
	for _, m := range []Monitor{
		{Name: "x", Type: "http", Target: "file:///etc/passwd"},
		{Name: "x", Type: "tcp", Target: "host"},
		{Name: "x", Type: "dns", Target: "example.com", Config: MonitorConfig{RecordType: "ANY"}},
		{Name: "x", Type: "exec", Target: "rm -rf /"},
		{Name: "", Type: "tcp", Target: "a:1"},
		{Name: "x", Type: "tcp", Target: "a:1", IntervalS: 5},
	} {
		if m.validate() == "" {
			t.Errorf("%+v must be rejected", m)
		}
	}
}

func TestEmailTemplateEscapes(t *testing.T) {
	evs := []Event{{Kind: "Sonde", Name: `<script>alert(1)</script>`, From: StatusOperational, To: StatusMajor, At: time.Now()}}
	subj, body, err := renderEmail("Alerte\r\nBcc: x@evil {{.Down}}", defaultEmailHTML, buildEmailData("T", "", evs))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "<script>") {
		t.Fatal("service name must be HTML-escaped")
	}
	if strings.ContainsAny(subj, "\r\n") {
		t.Fatal("subject must not contain line breaks")
	}
	if !strings.Contains(body, "#9d3533") {
		t.Fatal("status colour missing")
	}
}

func TestNotifierGroupsEvents(t *testing.T) {
	s, _ := newTestServer(t)
	s.setSetting("notify_window_s", "3600")
	for i := 0; i < 15; i++ {
		s.notifier.add(Event{Name: "svc", From: StatusOperational, To: StatusMajor, At: time.Now()})
	}
	s.notifier.mu.Lock()
	n, timer := len(s.notifier.pending), s.notifier.timer
	s.notifier.mu.Unlock()
	if n != 15 || timer == nil {
		t.Fatalf("expected 15 pending events behind a single timer, got %d", n)
	}
	timer.Stop()
}

func TestSettingsValidation(t *testing.T) {
	if validateSettings(map[string]string{"nope": "1"}) == "" {
		t.Fatal("unknown key accepted")
	}
	if validateSettings(map[string]string{"agent_interval_s": "1"}) == "" {
		t.Fatal("out of range accepted")
	}
	if validateSettings(map[string]string{"email_html": "{{.Broken"}) == "" {
		t.Fatal("broken template accepted")
	}
	if msg := validateSettings(map[string]string{"agent_interval_s": "60", "smtp_tls": "tls"}); msg != "" {
		t.Fatal(msg)
	}
}

func TestPasswordHash(t *testing.T) {
	h := hashPassword("correct horse battery")
	if !checkPassword(h, "correct horse battery") || checkPassword(h, "wrong") || checkPassword("garbage", "x") {
		t.Fatal("password hashing")
	}
}

func TestHTTPSCertificateCheck(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()
	m := Monitor{Name: "tls", Type: "http", Target: up.URL, Config: MonitorConfig{CheckSSL: true, IgnoreTLS: true}}
	if msg := m.validate(); msg != "" {
		t.Fatal(msg)
	}
	res := runCheck(context.Background(), &m)
	if res.status != StatusOperational || res.certExpiry == nil || !strings.Contains(res.message, "certificat valide") {
		t.Fatalf("got %+v", res)
	}
	plain := Monitor{Name: "x", Type: "http", Target: "http://example.fr", Config: MonitorConfig{CheckSSL: true}}
	if plain.validate() == "" {
		t.Fatal("check_ssl on http:// must be rejected")
	}
}

func TestCertificateWarningSentOnce(t *testing.T) {
	s, _ := newTestServer(t)
	s.setSetting("notify_window_s", "3600")
	m := Monitor{Name: "cloud", Type: "ssl", Target: "example.fr", Config: MonitorConfig{WarnDays: 3}}
	m.validate()
	id, err := s.insertMonitor(&m)
	if err != nil {
		t.Fatal(err)
	}
	soon := time.Now().Add(50 * time.Hour)
	for i := 0; i < 3; i++ {
		mons, _ := s.loadMonitors("WHERE id=?", id)
		if err := s.recordResult(&mons[0], checkResult{status: StatusOperational, certExpiry: &soon}, StatusOperational); err != nil {
			t.Fatal(err)
		}
	}
	s.notifier.mu.Lock()
	defer s.notifier.mu.Unlock()
	if len(s.notifier.pending) != 1 || s.notifier.pending[0].Kind != KindCert {
		t.Fatalf("expected exactly one certificate warning, got %+v", s.notifier.pending)
	}
	s.notifier.timer.Stop()
	d := buildEmailData("T", "", s.notifier.pending)
	subj, _, err := renderEmail(defaultSubject, defaultEmailHTML, d)
	if err != nil || !strings.Contains(subj, "Avertissement") {
		t.Fatalf("subject %q err %v", subj, err)
	}
}
