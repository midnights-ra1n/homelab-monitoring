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

func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.1.2", "v0.1.10", true}, {"v0.1.10", "v0.1.2", false}, {"v0.1.2", "v0.1.2", false},
		{"v0.2.0", "v0.1.9", false}, {"dev", "v0.1.2", false}, {"v0.1.2", "", false},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestHostActionRoundTrip(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	_, created := do(t, ts, "POST", "/api/hosts", cookie, map[string]string{"name": "pve"})
	token := created["install"].(map[string]any)["token"].(string)
	path := "/api/hosts/1/action"
	if resp, _ := do(t, ts, "POST", path, cookie, map[string]string{"action": "check_updates"}); resp.StatusCode != 409 {
		t.Fatalf("offline agent must give 409, got %d", resp.StatusCode)
	}

	nonce := make([]byte, 32)
	rand.Read(nonce)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/api/agent/ws", &websocket.DialOptions{HTTPHeader: http.Header{
		"Authorization": {"Bearer " + token}, "X-Agent-Nonce": {base64.StdEncoding.EncodeToString(nonce)}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var hello map[string]any
	wsjson.Read(ctx, c, &hello)

	if resp, out := do(t, ts, "POST", path, cookie, map[string]string{"action": "rm -rf /"}); resp.StatusCode != 400 {
		t.Fatalf("unknown action: %d %v", resp.StatusCode, out)
	}
	if resp, out := do(t, ts, "POST", path, cookie, map[string]string{"action": "apply_updates"}); resp.StatusCode != 200 || out["action"].(map[string]any)["state"] != "pending" {
		t.Fatalf("send action: %d %v", resp.StatusCode, out)
	}
	var got map[string]string
	if err := wsjson.Read(ctx, c, &got); err != nil || got["type"] != "action" || got["action"] != "apply_updates" {
		t.Fatalf("agent received %v %v", got, err)
	}
	if resp, _ := do(t, ts, "POST", path, cookie, map[string]string{"action": "check_updates"}); resp.StatusCode != 409 {
		t.Fatal("a second action while one is pending must give 409")
	}
	wsjson.Write(ctx, c, map[string]string{"type": "action_result", "action": "apply_updates", "state": "done", "message": "3 upgraded"})
	for i := 0; i < 50; i++ {
		_, h := do(t, ts, "GET", "/api/hosts/1", cookie, nil)
		if a, _ := h["action"].(map[string]any); a != nil && a["state"] == "done" && a["message"] == "3 upgraded" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("action result not stored")
}
