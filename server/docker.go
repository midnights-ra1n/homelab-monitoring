package main

// Docker containers reported by agents (see rust-agent/src/docker.rs).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type dockerContainer struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Image          string   `json:"image"`
	State          string   `json:"state"`  // running, exited, restarting, paused, created, dead
	Health         string   `json:"health"` // healthy, unhealthy, starting, "" without healthcheck
	StartedAt      string   `json:"started_at"`
	RestartCount   int      `json:"restart_count"`
	CPUPct         *float64 `json:"cpu_pct"`
	MemUsed        *float64 `json:"mem_used"`
	MemLimit       *float64 `json:"mem_limit"`
	NetRx          *float64 `json:"net_rx"` // cumulative bytes since the container started
	NetTx          *float64 `json:"net_tx"`
	ComposeProject string   `json:"compose_project"`
	ComposeService string   `json:"compose_service"`
	Update         string   `json:"update"` // up_to_date, available, unknown, local, pinned
}

type dockerSnapshot struct {
	Containers  []dockerContainer `json:"containers"`
	Error       string            `json:"error,omitempty"`
	CollectedAt int64             `json:"collected_at"`
	// Computed by the hub.
	Running          int `json:"running"`
	UpdatesAvailable int `json:"updates_available"`
	// Containers whose image update was already e-mailed (reported once).
	AlertedUpdates []string `json:"alerted_updates,omitempty"`
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (s *Server) storeDocker(id int64, hostName string, d *dockerSnapshot) error {
	if len(d.Containers) > 500 {
		d.Containers = d.Containers[:500]
	}
	d.Running, d.UpdatesAvailable = 0, 0
	for i := range d.Containers {
		c := &d.Containers[i]
		c.Name, c.Image, c.ID = clip(c.Name, 200), clip(c.Image, 300), clip(c.ID, 64)
		c.ComposeProject, c.ComposeService = clip(c.ComposeProject, 200), clip(c.ComposeService, 200)
		if c.State == "running" {
			d.Running++
		}
		if c.Update == "available" {
			d.UpdatesAvailable++
		}
	}
	d.Error = clip(d.Error, 500)

	var prev dockerSnapshot
	var raw string
	if s.db.QueryRow(`SELECT docker FROM hosts WHERE id=?`, id).Scan(&raw) == nil {
		json.Unmarshal([]byte(raw), &prev)
	}
	known := map[string]bool{}
	for _, k := range prev.AlertedUpdates {
		known[k] = true
	}
	var available, fresh []string
	for _, c := range d.Containers {
		if c.Update == "available" {
			k := c.Name + " " + c.Image
			available = append(available, k)
			if !known[k] {
				fresh = append(fresh, c.Name)
			}
		}
	}
	d.AlertedUpdates = available
	if len(fresh) > 0 && s.getSetting("notify_docker_updates", "false") == "true" {
		s.notifier.add(Event{Kind: KindImage, Name: hostName, Message: fmt.Sprintf("Nouvelle image disponible pour %s", strings.Join(fresh, ", ")), At: time.Now()})
	}
	d.CollectedAt = time.Now().Unix()
	b, _ := json.Marshal(d)
	_, err := s.db.Exec(`UPDATE hosts SET docker=? WHERE id=?`, string(b), id)
	return err
}

func (s *Server) handleContainers(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	type row struct {
		HostID int64           `json:"host_id"`
		Host   string          `json:"host"`
		Docker *dockerSnapshot `json:"docker"`
	}
	out := []row{}
	for _, h := range hosts {
		if h.Docker != nil {
			out = append(out, row{h.ID, h.Name, h.Docker})
		}
	}
	writeJSON(w, 200, out)
}
