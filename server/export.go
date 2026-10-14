package main

import (
	"net/http"
	"time"
)

// exportDoc is the import/export format. Secrets (SMTP password, agent tokens) are never
// included: hosts are exported by name only and need a new token after import.
type exportDoc struct {
	Format     string            `json:"format"`
	ExportedAt int64             `json:"exported_at"`
	Settings   map[string]string `json:"settings"`
	Monitors   []monitorInput    `json:"monitors"`
	Hosts      []string          `json:"hosts"`
	Metrics    *exportMetrics    `json:"metrics,omitempty"`
}

type exportMetrics struct {
	Hosts    map[string][][]any `json:"hosts"`    // host name -> rows [ts,cpu,mem_used,mem_total,disk_used,disk_total,net_rx,net_tx,load1,temp]
	Monitors map[string][][]any `json:"monitors"` // monitor name -> rows [ts_ms,status,latency_ms,message]
}

const exportFormat = "hlm-export-v1"

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	doc := exportDoc{Format: exportFormat, ExportedAt: time.Now().Unix(), Settings: s.allSettings()}
	delete(doc.Settings, "smtp_pass")
	mons, err := s.loadMonitors("")
	if err != nil {
		serverErr(w, err)
		return
	}
	for _, m := range mons {
		en := m.Enabled
		doc.Monitors = append(doc.Monitors, monitorInput{Name: m.Name, Type: m.Type, Target: m.Target, IntervalS: m.IntervalS,
			TimeoutS: m.TimeoutS, Config: m.Config, Enabled: &en, Maintenance: m.Maintenance, Public: m.Public})
	}
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	for _, h := range hosts {
		doc.Hosts = append(doc.Hosts, h.Name)
	}
	if r.URL.Query().Get("metrics") == "1" {
		doc.Metrics = &exportMetrics{Hosts: map[string][][]any{}, Monitors: map[string][][]any{}}
		for _, h := range hosts {
			rows, err := s.queryRows(`SELECT ts,cpu,mem_used,mem_total,disk_used,disk_total,net_rx,net_tx,load1,temp FROM host_metrics WHERE host_id=? ORDER BY ts`, 10, h.ID)
			if err != nil {
				serverErr(w, err)
				return
			}
			doc.Metrics.Hosts[h.Name] = rows
		}
		for _, m := range mons {
			rows, err := s.queryRows(`SELECT ts,status,latency_ms,message FROM monitor_results WHERE monitor_id=? ORDER BY ts`, 4, m.ID)
			if err != nil {
				serverErr(w, err)
				return
			}
			doc.Metrics.Monitors[m.Name] = rows
		}
	}
	w.Header().Set("Content-Disposition", `attachment; filename="hlm-export-`+time.Now().Format("2006-01-02")+`.json"`)
	writeJSON(w, 200, doc)
}

func (s *Server) queryRows(q string, cols int, args ...any) ([][]any, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][]any{}
	for rows.Next() {
		vals := make([]any, cols)
		ptrs := make([]any, cols)
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		out = append(out, vals)
	}
	return out, rows.Err()
}

// handleImport adds the monitors and applies the settings of an export. Existing monitors
// with the same name are kept untouched; metrics in the file are ignored.
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var doc exportDoc
	if !readJSONLimit(w, r, &doc, 256<<20) { // exports may embed metrics
		return
	}
	if doc.Format != exportFormat {
		writeErr(w, 400, "Format de fichier non reconnu (attendu "+exportFormat+")")
		return
	}
	delete(doc.Settings, "smtp_pass")
	if msg := validateSettings(doc.Settings); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	existing := map[string]bool{}
	mons, err := s.loadMonitors("")
	if err != nil {
		serverErr(w, err)
		return
	}
	for _, m := range mons {
		existing[m.Name] = true
	}
	var toAdd []Monitor
	for _, in := range doc.Monitors {
		m, msg := in.toMonitor()
		if msg != "" {
			writeErr(w, 400, "Sonde « "+in.Name+" » : "+msg)
			return
		}
		if !existing[m.Name] {
			toAdd = append(toAdd, m)
		}
	}
	for k, v := range doc.Settings {
		if err := s.setSetting(k, v); err != nil {
			serverErr(w, err)
			return
		}
	}
	for i := range toAdd {
		if _, err := s.insertMonitor(&toAdd[i]); err != nil {
			serverErr(w, err)
			return
		}
	}
	writeJSON(w, 200, map[string]int{"monitors_added": len(toAdd), "settings_applied": len(doc.Settings)})
}
