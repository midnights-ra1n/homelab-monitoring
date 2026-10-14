package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// dialAgent performs the agent handshake and returns the hello message.
func dialAgent(t *testing.T, wsURL, token, hostname string) (map[string]any, int) {
	t.Helper()
	nonce := make([]byte, 32)
	rand.Read(nonce)
	hdr := http.Header{"Authorization": {"Bearer " + token}, "X-Agent-Nonce": {base64.StdEncoding.EncodeToString(nonce)}, "X-Agent-Hostname": {hostname}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		return nil, resp.StatusCode
	}
	defer c.CloseNow()
	var hello map[string]any
	if err := wsjson.Read(ctx, c, &hello); err != nil {
		t.Fatal(err)
	}
	return hello, 101
}

func TestEnrollmentToken(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	resp, out := do(t, ts, "POST", "/api/enroll-tokens", cookie, map[string]any{"name": "parc"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %v", resp.StatusCode, out)
	}
	shared := out["install"].(map[string]any)["token"].(string)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/agent/ws"

	hello, _ := dialAgent(t, wsURL, shared, "pve-01.lan")
	personal, _ := hello["token"].(string)
	if personal == "" || personal == shared {
		t.Fatalf("enrolled agent must receive a personal token: %v", hello)
	}
	// The personal token reconnects to the same host, without enrolling again.
	if hello2, code := dialAgent(t, wsURL, personal, "pve-01.lan"); code != 101 || hello2["token"] != nil {
		t.Fatalf("personal token: %d %v", code, hello2)
	}
	// A second machine with the same name gets its own host, never the first one.
	dialAgent(t, wsURL, shared, "pve-01")
	hosts, _ := s.loadHosts("")
	if len(hosts) != 2 || hosts[0].Name != "pve-01" || hosts[1].Name != "pve-01-2" {
		t.Fatalf("hosts: %+v", hosts)
	}
	// Expired enrollment token.
	s.db.Exec(`UPDATE enroll_tokens SET expires_at=1`)
	if _, code := dialAgent(t, wsURL, shared, "x"); code != 401 {
		t.Fatalf("expired enrollment token: %d", code)
	}
}

func TestAgentHubURLSetting(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	if resp, _ := do(t, ts, "PUT", "/api/settings", cookie, map[string]string{"agent_hub_url": "https://x.fr' ; rm -rf /"}); resp.StatusCode != 400 {
		t.Fatal("shell metacharacters must be refused in the hub URL")
	}
	do(t, ts, "PUT", "/api/settings", cookie, map[string]string{"agent_hub_url": "https://monitoring.lan/"})
	_, out := do(t, ts, "POST", "/api/hosts", cookie, map[string]string{"name": "a"})
	if hub := out["install"].(map[string]any)["hub_url"]; hub != "https://monitoring.lan" {
		t.Fatalf("hub_url %v", hub)
	}
}
