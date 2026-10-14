package main

// Actions sent from the dashboard to a connected agent, and the latest agent release.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket/wsjson"
)

var hostActions = map[string]bool{"check_updates": true, "apply_updates": true, "update_agent": true}

func (s *Server) setHostAction(id int64, action, state, message string) {
	if len(message) > 4000 {
		message = message[len(message)-4000:]
	}
	b, _ := json.Marshal(hostAction{Action: action, State: state, Message: message, At: time.Now().Unix()})
	if _, err := s.db.Exec(`UPDATE hosts SET action=? WHERE id=?`, string(b), id); err != nil {
		slog.Error("store host action", "err", err)
	}
}

func (s *Server) handleHostAction(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !hostActions[req.Action] {
		writeErr(w, 400, "Action inconnue : check_updates, apply_updates ou update_agent")
		return
	}
	hosts, err := s.loadHosts("WHERE id=?", id)
	if err != nil {
		serverErr(w, err)
		return
	}
	if len(hosts) == 0 {
		writeErr(w, 404, "Hôte introuvable")
		return
	}
	// One apt action at a time per host: an upgrade can take a while.
	if a := hosts[0].Action; a != nil && (a.State == "pending" || a.State == "running") && time.Since(time.Unix(a.At, 0)) < 2*time.Hour {
		writeErr(w, 409, "Une action est déjà en cours sur cet hôte")
		return
	}
	s.agentsMu.Lock()
	conn := s.agents[id]
	s.agentsMu.Unlock()
	if conn == nil {
		writeErr(w, 409, "L'agent n'est pas connecté")
		return
	}
	ctx, cancel := context.WithTimeout(conn.ctx, 10*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, conn.conn, map[string]string{"type": "action", "action": req.Action}); err != nil {
		writeErr(w, 502, "Impossible de joindre l'agent : "+err.Error())
		return
	}
	s.setHostAction(id, req.Action, "pending", "")
	s.handleGetHost(w, r)
}

// Latest agent release, from GitHub every 6 hours. Falls back to the hub's own version,
// since hub and agents are released together.
var agentRelease struct {
	sync.Mutex
	tag string
}

func latestAgentVersion() string {
	agentRelease.Lock()
	defer agentRelease.Unlock()
	if agentRelease.tag != "" {
		return agentRelease.tag
	}
	if strings.HasPrefix(version, "v") {
		return version
	}
	return ""
}

func (s *Server) runReleaseCheck(ctx context.Context) {
	client := &http.Client{Timeout: 20 * time.Second}
	for {
		req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/midnights-ra1n/homelab-monitoring/releases/latest", nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		if resp, err := client.Do(req); err == nil {
			var rel struct {
				Tag string `json:"tag_name"`
			}
			if resp.StatusCode == 200 && json.NewDecoder(resp.Body).Decode(&rel) == nil && strings.HasPrefix(rel.Tag, "v") {
				agentRelease.Lock()
				agentRelease.tag = rel.Tag
				agentRelease.Unlock()
			}
			resp.Body.Close()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(6 * time.Hour):
		}
	}
}

// versionLess compares release tags like v0.1.12 numerically; unknown versions never compare as older.
func versionLess(a, b string) bool {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if !strings.HasPrefix(v, "v") || len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
