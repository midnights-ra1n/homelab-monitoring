package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func apiReq(t *testing.T, ts *httptest.Server, method, path, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func createToken(t *testing.T, ts *httptest.Server, cookie string, scopes []string, exp *int64) string {
	t.Helper()
	resp, out := do(t, ts, "POST", "/api/tokens", cookie, map[string]any{"name": "gestion", "scopes": scopes, "expires_at": exp})
	if resp.StatusCode != 201 {
		t.Fatalf("create token: %d %v", resp.StatusCode, out)
	}
	tok := out["token"].(string)
	if !strings.HasPrefix(tok, "hlm_") {
		t.Fatalf("token format %q", tok)
	}
	return tok
}

func TestAPITokens(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	tok := createToken(t, ts, cookie, []string{"status:read", "hosts:read"}, nil)

	if code, _ := apiReq(t, ts, "GET", "/api/v1/status", tok, ""); code != 404 {
		t.Fatalf("API must be off by default, got %d", code)
	}
	s.setSetting("api_enabled", "true")
	if code, out := apiReq(t, ts, "GET", "/api/v1/status", tok, ""); code != 200 || out["status"] == nil {
		t.Fatalf("status: %d %v", code, out)
	}
	if code, _ := apiReq(t, ts, "GET", "/api/v1/monitors", tok, ""); code != 403 {
		t.Fatalf("missing scope must give 403, got %d", code)
	}
	if code, _ := apiReq(t, ts, "GET", "/api/v1/status", "hlm_wrong", ""); code != 401 {
		t.Fatalf("bad token: %d", code)
	}
	// The session cookie is never accepted by /api/v1.
	if resp, _ := do(t, ts, "GET", "/api/v1/status", cookie, nil); resp.StatusCode != 401 {
		t.Fatalf("cookie must not authenticate /api/v1, got %d", resp.StatusCode)
	}

	past := time.Now().Add(-time.Hour).Unix()
	if resp, _ := do(t, ts, "POST", "/api/tokens", cookie, map[string]any{"name": "x", "scopes": []string{"status:read"}, "expires_at": past}); resp.StatusCode != 400 {
		t.Fatal("expiry in the past must be refused")
	}
	if resp, _ := do(t, ts, "POST", "/api/tokens", cookie, map[string]any{"name": "x", "scopes": []string{"admin"}}); resp.StatusCode != 400 {
		t.Fatal("unknown scope must be refused")
	}
	soon := time.Now().Add(time.Hour).Unix()
	short := createToken(t, ts, cookie, []string{"status:read"}, &soon)
	s.db.Exec(`UPDATE api_tokens SET expires_at=? WHERE expires_at=?`, past, soon)
	if code, out := apiReq(t, ts, "GET", "/api/v1/status", short, ""); code != 401 || !strings.Contains(out["error"].(string), "expiré") {
		t.Fatalf("expired token: %d %v", code, out)
	}

	// Revocation.
	_, list := do(t, ts, "GET", "/api/tokens", cookie, nil)
	var first map[string]any
	for _, x := range list["tokens"].([]any) {
		if x.(map[string]any)["prefix"] == tok[:10] {
			first = x.(map[string]any)
		}
	}
	if strings.Contains(jsonNum(list), tok) {
		t.Fatal("token list must never contain the secret")
	}
	if resp, _ := do(t, ts, "DELETE", "/api/tokens/"+jsonNum(first["id"]), cookie, nil); resp.StatusCode != 204 {
		t.Fatal("revoke")
	}
	if code, _ := apiReq(t, ts, "GET", "/api/v1/status", tok, ""); code != 401 {
		t.Fatalf("revoked token still works: %d", code)
	}
}

func jsonNum(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestAPIMaintenanceAndCORS(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	s.setSetting("api_enabled", "true")
	s.setSetting("api_cors_origins", "https://gestion.example.fr")
	m := Monitor{Name: "a", Type: "tcp", Target: "127.0.0.1:1"}
	m.validate()
	id, _ := s.insertMonitor(&m)
	ro := createToken(t, ts, cookie, []string{"monitors:read"}, nil)
	rw := createToken(t, ts, cookie, []string{"maintenance:write"}, nil)
	path := "/api/v1/monitors/" + jsonNum(id) + "/maintenance"
	if code, _ := apiReq(t, ts, "PUT", path, ro, `{"maintenance":true}`); code != 403 {
		t.Fatalf("read-only token wrote: %d", code)
	}
	// Cross-origin PUT with a token is fine: no cookie is involved.
	req, _ := http.NewRequest("PUT", ts.URL+path, strings.NewReader(`{"maintenance":true}`))
	req.Header.Set("Authorization", "Bearer "+rw)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://gestion.example.fr")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "https://gestion.example.fr" {
		t.Fatalf("maintenance via API: %v %v", resp.StatusCode, err)
	}
	mons, _ := s.loadMonitors("WHERE id=?", id)
	if !mons[0].Maintenance {
		t.Fatal("maintenance not applied")
	}
	req, _ = http.NewRequest("OPTIONS", ts.URL+path, nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, _ = http.DefaultClient.Do(req)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unlisted origin got CORS headers")
	}
}

func f(x float64) *float64 { return &x }

func TestSmartAnalysis(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		d    smartDisk
		want string
	}{
		{smartDisk{Kind: "ssd", SmartPassed: &yes, WearUsedPct: f(10), PowerOnHours: f(8760)}, DiskGood},
		{smartDisk{Kind: "hdd", SmartPassed: &yes, PowerOnHours: f(1000), Reallocated: f(8)}, DiskWatch},
		{smartDisk{Kind: "hdd", SmartPassed: &yes, PowerOnHours: f(1000), Pending: f(3)}, DiskReplace},
		{smartDisk{Kind: "nvme", SmartPassed: &no}, DiskFailing},
		{smartDisk{Kind: "nvme", SmartPassed: &yes, SparePct: f(5), SpareThreshPct: f(10)}, DiskFailing},
	}
	for i, c := range cases {
		if h := analyzeDisk(c.d); h.Health != c.want {
			t.Errorf("case %d: got %s (%v), want %s", i, h.Health, h.Reasons, c.want)
		}
	}
	// SSD with 10 % wear after one year: about nine more years at the same pace.
	h := analyzeDisk(cases[0].d)
	if h.LifeLeftDays == nil || *h.LifeLeftDays < 3200 || *h.LifeLeftDays > 3300 || !h.Usable {
		t.Fatalf("ssd life estimate %v", h.LifeLeftDays)
	}
	if h := analyzeDisk(cases[2].d); h.Usable || *h.LifeLeftDays != 0 {
		t.Fatal("a disk to replace must not be reported as usable")
	}
}

func TestSmartAlertOnDegradation(t *testing.T) {
	s, _ := newTestServer(t)
	s.setSetting("notify_window_s", "3600")
	res, _ := s.db.Exec(`INSERT INTO hosts(name,token_hash,created_at) VALUES('nas',x'01',0)`)
	id, _ := res.LastInsertId()
	yes := true
	good := &smartReport{Disks: []smartDisk{{Name: "/dev/sda", Serial: "S1", Kind: "hdd", SmartPassed: &yes, PowerOnHours: f(100)}}}
	s.storeSmart(id, "nas", good)
	bad := &smartReport{Disks: []smartDisk{{Name: "/dev/sda", Serial: "S1", Kind: "hdd", SmartPassed: &yes, PowerOnHours: f(100), Pending: f(4)}}}
	s.storeSmart(id, "nas", bad)
	s.storeSmart(id, "nas", bad) // same state again: no new alert
	s.notifier.mu.Lock()
	defer s.notifier.mu.Unlock()
	if len(s.notifier.pending) != 1 || s.notifier.pending[0].Kind != KindDisk {
		t.Fatalf("expected one disk alert, got %+v", s.notifier.pending)
	}
	s.notifier.timer.Stop()
}

func TestEmailBlocks(t *testing.T) {
	blocks, msg := parseEmailBlocks(`[{"id":"1","type":"header","text":"<b>{titre}</b>"},{"id":"2","type":"events"},{"id":"3","type":"button","label":"Voir","url":"https://x.fr"}]`)
	if msg != "" {
		t.Fatal(msg)
	}
	evs := []Event{{Kind: "Sonde", Name: "<img src=x onerror=alert(1)>", From: StatusOperational, To: StatusMajor, At: time.Now()}}
	body, err := renderEmailBlocks(blocks, buildEmailData("Lab", "", evs))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "<img") || strings.Contains(body, "<b>Lab") || !strings.Contains(body, "&lt;b&gt;Lab") || !strings.Contains(body, `href="https://x.fr"`) {
		t.Fatalf("blocks must be escaped and rendered: %s", body)
	}
	if _, msg := parseEmailBlocks(`[{"id":"1","type":"button","url":"javascript:alert(1)"}]`); msg == "" {
		t.Fatal("javascript: link accepted")
	}
	if _, msg := parseEmailBlocks(`[{"id":"1","type":"script"}]`); msg == "" {
		t.Fatal("unknown block accepted")
	}
}

func TestStatusPageExposesOnlyReferencedItems(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	pub := Monitor{Name: "site public", Type: "tcp", Target: "127.0.0.1:1", Enabled: true}
	pub.validate()
	pid, _ := s.insertMonitor(&pub)
	secret := Monitor{Name: "secret-interne", Type: "tcp", Target: "10.0.0.5:22", Enabled: true}
	secret.validate()
	s.insertMonitor(&secret)
	layout := map[string]any{"enabled": true, "blocks": []map[string]any{
		{"id": "h", "type": "header", "title": "Mon lab"},
		{"id": "c", "type": "components", "title": "Services", "items": []map[string]any{{"kind": "monitor", "id": pid}}, "show_uptime": true, "days": 30},
		{"id": "l", "type": "latency", "monitor_id": pid},
	}}
	if resp, out := do(t, ts, "PUT", "/api/status/layout", cookie, layout); resp.StatusCode != 200 {
		t.Fatalf("save layout: %d %v", resp.StatusCode, out)
	}
	resp, err := http.Get(ts.URL + "/api/public/status")
	if err != nil {
		t.Fatal(err)
	}
	var page map[string]any
	json.NewDecoder(resp.Body).Decode(&page)
	raw, _ := json.Marshal(page)
	if strings.Contains(string(raw), "secret-interne") || strings.Contains(string(raw), "10.0.0.5") || strings.Contains(string(raw), "127.0.0.1") {
		t.Fatalf("public page leaks unreferenced data or targets: %s", raw)
	}
	if page["title"] != "Mon lab" || !strings.Contains(string(raw), "site public") {
		t.Fatalf("page: %s", raw)
	}
	days := page["blocks"].([]any)[1].(map[string]any)["data"].([]any)[0].(map[string]any)["days"].([]any)
	if len(days) != 30 {
		t.Fatalf("expected 30 days, got %d", len(days))
	}
	bad := map[string]any{"blocks": []map[string]any{{"id": "x", "type": "iframe"}}}
	if resp, _ := do(t, ts, "PUT", "/api/status/layout", cookie, bad); resp.StatusCode != 400 {
		t.Fatal("unknown block type accepted")
	}
}

func TestMonthlyReport(t *testing.T) {
	s, _ := newTestServer(t)
	m := Monitor{Name: "web", Type: "tcp", Target: "127.0.0.1:1"}
	m.validate()
	id, _ := s.insertMonitor(&m)
	start := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	// 9 Sept: 90/100 checks up with one major outage; 10 Sept: all up.
	s.db.Exec(`INSERT INTO monitor_daily(monitor_id,day,total,up,worst,latency_sum,latency_n) VALUES(?,?,100,90,4,1000,100),(?,?,100,100,0,2000,100)`,
		id, start.AddDate(0, 0, 8).Unix(), id, start.AddDate(0, 0, 9).Unix())
	rep, err := s.monthlyReport(start)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Month != "2026-09" || rep.Uptime == nil || *rep.Uptime != 0.95 || rep.IncidentDays != 1 || *rep.Monitors[0].AvgLatencyMs != 15 {
		t.Fatalf("report %+v", rep)
	}
}

func TestAPIRegisterHost(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	s.setSetting("api_enabled", "true")
	tok := createToken(t, ts, cookie, []string{"hosts:write"}, nil)
	code, out := apiReq(t, ts, "POST", "/api/v1/hosts", tok, `{"name":"pve-02"}`)
	if code != 201 || out["created"] != true {
		t.Fatalf("register: %d %v", code, out)
	}
	first := out["install"].(map[string]any)["token"].(string)
	if code, _ := apiReq(t, ts, "POST", "/api/v1/hosts", tok, `{"name":"pve-02"}`); code != 409 {
		t.Fatalf("duplicate name must give 409, got %d", code)
	}
	code, out = apiReq(t, ts, "POST", "/api/v1/hosts", tok, `{"name":"pve-02","rotate_if_exists":true}`)
	second := out["install"].(map[string]any)["token"].(string)
	if code != 200 || out["created"] != false || second == first {
		t.Fatalf("rotate: %d %v", code, out)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM hosts WHERE token_hash=?`, hashToken(first)).Scan(&n)
	if n != 0 {
		t.Fatal("old agent token must be revoked by rotation")
	}
}
