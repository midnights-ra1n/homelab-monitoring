package main

// Block-based public status page. The layout (setting status_layout) is the only thing that
// decides what is public: an item appears on the page only if a block references it.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type statusItemRef struct {
	Kind string `json:"kind"` // host or monitor
	ID   int64  `json:"id"`
}

type statusBlock struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"` // header, overall, components, uptime, latency, text
	Title      string          `json:"title,omitempty"`
	Text       string          `json:"text,omitempty"`
	Items      []statusItemRef `json:"items,omitempty"`
	ShowUptime bool            `json:"show_uptime,omitempty"`
	Days       int             `json:"days,omitempty"`
	MonitorID  int64           `json:"monitor_id,omitempty"`
	Range      string          `json:"range,omitempty"`
	Data       any             `json:"data,omitempty"` // filled when the page is served
}

var statusBlockTypes = map[string]bool{"header": true, "overall": true, "components": true, "uptime": true, "latency": true, "text": true}

func validateStatusLayout(blocks []statusBlock) string {
	if len(blocks) > 40 {
		return "La page peut contenir au plus 40 blocs"
	}
	for i := range blocks {
		b := &blocks[i]
		b.Data = nil
		if !statusBlockTypes[b.Type] {
			return "Type de bloc inconnu : " + b.Type
		}
		if b.ID == "" || len(b.ID) > 40 {
			return "Chaque bloc doit avoir un identifiant de 1 à 40 caractères"
		}
		if len(b.Title) > 200 || len(b.Text) > 5000 {
			return "Titre limité à 200 caractères et texte à 5 000"
		}
		if len(b.Items) > 100 {
			return "Un bloc peut contenir au plus 100 éléments"
		}
		for _, it := range b.Items {
			if it.Kind != "host" && it.Kind != "monitor" {
				return "Un élément doit être un hôte ou une sonde"
			}
		}
		if b.Days == 0 {
			b.Days = 90
		}
		if b.Days != 30 && b.Days != 60 && b.Days != 90 {
			return "L'historique doit couvrir 30, 60 ou 90 jours"
		}
		if b.Type == "latency" {
			if b.Range == "" {
				b.Range = "24h"
			}
			if b.Range != "24h" && b.Range != "7d" && b.Range != "30d" {
				return "La période de latence doit être 24h, 7d ou 30d"
			}
		}
	}
	return ""
}

func (s *Server) statusLayout() []statusBlock {
	var blocks []statusBlock
	if raw := s.getSetting("status_layout", ""); raw != "" && json.Unmarshal([]byte(raw), &blocks) == nil {
		return blocks
	}
	// Default page, built from the per-item "public" flags of earlier versions.
	items := []statusItemRef{}
	hosts, _ := s.loadHosts("WHERE public=1")
	for _, h := range hosts {
		items = append(items, statusItemRef{"host", h.ID})
	}
	mons, _ := s.loadMonitors("WHERE public=1")
	for _, m := range mons {
		items = append(items, statusItemRef{"monitor", m.ID})
	}
	return []statusBlock{
		{ID: "header", Type: "header", Title: s.getSetting("status_title", "Homelab"), Text: s.getSetting("status_description", "")},
		{ID: "overall", Type: "overall"},
		{ID: "services", Type: "components", Title: "Services", Items: items, ShowUptime: true, Days: 90},
	}
}

type publicItem struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Days   []Day  `json:"days,omitempty"`
}

// resolveStatus fills each block with the public data it needs, and nothing more.
func (s *Server) resolveStatus(blocks []statusBlock) (map[string]any, error) {
	hostsByID, monsByID := map[int64]Host{}, map[int64]Monitor{}
	hosts, err := s.loadHosts("")
	if err != nil {
		return nil, err
	}
	for _, h := range hosts {
		hostsByID[h.ID] = h
	}
	mons, err := s.loadMonitors("WHERE enabled=1")
	if err != nil {
		return nil, err
	}
	if err := s.attachDays(mons, 90); err != nil {
		return nil, err
	}
	for _, m := range mons {
		monsByID[m.ID] = m
	}
	var statuses []string
	title := s.getSetting("status_title", "Homelab")
	out := make([]statusBlock, 0, len(blocks))
	for _, b := range blocks {
		switch b.Type {
		case "header":
			if b.Title != "" {
				title = b.Title
			}
		case "components", "uptime":
			items := []publicItem{}
			var sum float64
			var n int
			for _, ref := range b.Items {
				if ref.Kind == "host" {
					if h, ok := hostsByID[ref.ID]; ok {
						items = append(items, publicItem{Name: h.Name, Kind: "host", Status: h.Status})
						statuses = append(statuses, h.Status)
					}
				} else if m, ok := monsByID[ref.ID]; ok {
					days := m.Days[len(m.Days)-b.Days:]
					it := publicItem{Name: m.Name, Kind: "monitor", Status: m.Status}
					if b.ShowUptime || b.Type == "uptime" {
						it.Days = days
					}
					for _, d := range days {
						if d.Uptime != nil {
							sum += *d.Uptime
							n++
						}
					}
					items = append(items, it)
					statuses = append(statuses, m.Status)
				}
			}
			if b.Type == "uptime" {
				var avg *float64
				if n > 0 {
					a := sum / float64(n)
					avg = &a
				}
				b.Data = map[string]any{"uptime": avg, "count": len(items)}
			} else {
				b.Data = items
			}
		case "latency":
			m, ok := monsByID[b.MonitorID]
			if !ok {
				continue
			}
			d := map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[b.Range]
			sr, err := s.latencySeries(m.ID, d, max(d.Milliseconds()/200, 60_000))
			if err != nil {
				return nil, err
			}
			sr["name"] = m.Name
			delete(sr, "worst")
			b.Data = sr
		}
		out = append(out, b)
	}
	return map[string]any{"title": title, "status": overallStatus(statuses), "blocks": out, "updated_at": time.Now().Unix()}, nil
}

// Public page: unauthenticated, so the resolved page is cached for 30 seconds.
var publicCache struct {
	sync.Mutex
	at   time.Time
	body []byte
}

func (s *Server) handlePublicStatus(w http.ResponseWriter, r *http.Request) {
	if s.getSetting("status_enabled", "false") != "true" {
		writeErr(w, 404, "Page de statut désactivée")
		return
	}
	publicCache.Lock()
	defer publicCache.Unlock()
	if time.Since(publicCache.at) > 30*time.Second {
		page, err := s.resolveStatus(s.statusLayout())
		if err != nil {
			serverErr(w, err)
			return
		}
		publicCache.body, _ = json.Marshal(page)
		publicCache.at = time.Now()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(publicCache.body)
}

func (s *Server) handleGetStatusLayout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"blocks": s.statusLayout(), "enabled": s.getSetting("status_enabled", "false") == "true"})
}

func (s *Server) handlePutStatusLayout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Blocks  []statusBlock `json:"blocks"`
		Enabled *bool         `json:"enabled"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if msg := validateStatusLayout(req.Blocks); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	b, _ := json.Marshal(req.Blocks)
	if err := s.setSetting("status_layout", string(b)); err != nil {
		serverErr(w, err)
		return
	}
	if req.Enabled != nil {
		s.setSetting("status_enabled", strconv.FormatBool(*req.Enabled))
	}
	publicCache.Lock()
	publicCache.at = time.Time{}
	publicCache.Unlock()
	s.handleGetStatusLayout(w, r)
}

// handlePreviewStatus renders an unsaved layout for the editor, even while the page is disabled.
func (s *Server) handlePreviewStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Blocks []statusBlock `json:"blocks"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if msg := validateStatusLayout(req.Blocks); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	page, err := s.resolveStatus(req.Blocks)
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, page)
}
