package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// settingDefs lists every user-editable setting with its default value.
// smtp_pass is write-only: it is never sent back to the browser or exported.
var settingDefs = map[string]string{
	"agent_interval_s":        "30",
	"retention_metrics_days":  "30",
	"retention_results_days":  "30",
	"retention_daily_days":    "365",
	"notify_window_s":         "60",
	"smtp_enabled":            "false",
	"smtp_host":               "",
	"smtp_port":               "587",
	"smtp_tls":                "starttls",
	"smtp_user":               "",
	"smtp_pass":               "",
	"smtp_from":               "",
	"smtp_to":                 "",
	"email_subject":           defaultSubject,
	"email_html":              defaultEmailHTML,
	"status_enabled":          "false",
	"status_title":            "Homelab",
	"status_description":      "",
	"dashboard_layout":        "",
	"email_mode":              "blocks",
	"email_blocks":            defaultEmailBlocks,
	"status_layout":           "",
	"api_enabled":             "false",
	"api_cors_origins":        "",
	"agent_hub_url":           "",
	"timezone":                defaultTimezone,
	"notify_security_updates": "true",
	"notify_reboot":           "true",
	"notify_smart_level":      DiskReplace,
	"notify_docker_updates":   "false",
	"report_monthly_enabled":  "false",
}

var intSettings = map[string][2]int{
	"agent_interval_s":       {5, 3600},
	"retention_metrics_days": {1, 3650},
	"retention_results_days": {1, 3650},
	"retention_daily_days":   {90, 3650},
	"notify_window_s":        {0, 3600},
	"smtp_port":              {1, 65535},
}

func (s *Server) allSettings() map[string]string {
	out := map[string]string{}
	for k, v := range settingDefs {
		out[k] = s.getSetting(k, v)
	}
	return out
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	out := s.allSettings()
	out["smtp_pass_set"] = strconv.FormatBool(out["smtp_pass"] != "")
	delete(out, "smtp_pass")
	var size int64
	if fi, err := os.Stat(filepath.Join(s.cfg.DataDir, "hlm.db")); err == nil {
		size = fi.Size()
	}
	if fi, err := os.Stat(filepath.Join(s.cfg.DataDir, "hlm.db-wal")); err == nil {
		size += fi.Size()
	}
	writeJSON(w, 200, map[string]any{"settings": out, "db_size": size, "version": version})
}

// validateSettings rejects unknown keys and out-of-range numbers, and checks templates compile.
func validateSettings(in map[string]string) string {
	for k, v := range in {
		if _, ok := settingDefs[k]; !ok {
			return "Réglage inconnu : " + k
		}
		if len(v) > 256<<10 {
			return "La valeur de " + k + " dépasse 256 Ko"
		}
		if rng, ok := intSettings[k]; ok {
			n, err := strconv.Atoi(v)
			if err != nil || n < rng[0] || n > rng[1] {
				return k + " doit être un nombre entre " + strconv.Itoa(rng[0]) + " et " + strconv.Itoa(rng[1])
			}
		}
	}
	if v, ok := in["smtp_tls"]; ok && v != "starttls" && v != "tls" && v != "none" {
		return "Le chiffrement SMTP doit être starttls, tls ou none"
	}
	if v, ok := in["timezone"]; ok && v != "" {
		if _, err := time.LoadLocation(v); err != nil || v == "Local" {
			return "Fuseau horaire inconnu : " + v + " (exemple : Europe/Paris)"
		}
	}
	if v, ok := in["email_mode"]; ok && v != "blocks" && v != "html" {
		return "Le mode d'e-mail doit être blocks ou html"
	}
	if v := in["email_blocks"]; v != "" {
		if _, msg := parseEmailBlocks(v); msg != "" {
			return msg
		}
	}
	if v := in["status_layout"]; v != "" {
		var blocks []statusBlock
		if err := json.Unmarshal([]byte(v), &blocks); err != nil {
			return "Disposition de la page de statut invalide"
		}
		if msg := validateStatusLayout(blocks); msg != "" {
			return msg
		}
	}
	if v := strings.TrimSpace(in["agent_hub_url"]); v != "" {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || strings.ContainsAny(v, "'\" \\`$") {
			return "L'adresse du hub doit ressembler à https://monitoring.example.fr"
		}
	}
	for _, o := range strings.Split(in["api_cors_origins"], ",") {
		if o = strings.TrimSpace(o); o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			return "Chaque origine CORS doit ressembler à https://gestion.example.fr"
		}
	}
	if v, ok := in["notify_smart_level"]; ok && v != DiskWatch && v != DiskReplace && v != DiskFailing && v != "off" {
		return "Le seuil d'alerte SMART doit être watch, replace, failing ou off"
	}
	for _, k := range []string{"smtp_enabled", "status_enabled", "api_enabled", "report_monthly_enabled", "notify_security_updates", "notify_reboot", "notify_docker_updates"} {
		if v, ok := in[k]; ok && v != "true" && v != "false" {
			return k + " doit valoir true ou false"
		}
	}
	if in["email_subject"] != "" || in["email_html"] != "" {
		subj, body := in["email_subject"], in["email_html"]
		if subj == "" {
			subj = defaultSubject
		}
		if body == "" {
			body = defaultEmailHTML
		}
		if _, _, err := renderEmail(subj, body, buildEmailData("Homelab", "", sampleEvents())); err != nil {
			return err.Error()
		}
	}
	return ""
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if !readJSON(w, r, &in) {
		return
	}
	if msg := validateSettings(in); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		serverErr(w, err)
		return
	}
	defer tx.Rollback()
	for k, v := range in {
		if k == "smtp_pass" && v == "" {
			continue // empty means "keep the current password"
		}
		if v == "" { // empty restores the default value
			if _, err := tx.Exec(`DELETE FROM settings WHERE key=?`, k); err != nil {
				serverErr(w, err)
				return
			}
			continue
		}
		if _, err := tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v); err != nil {
			serverErr(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		serverErr(w, err)
		return
	}
	s.loadTimezone()
	s.handleGetSettings(w, r)
}

func (s *Server) handleTestEmail(w http.ResponseWriter, r *http.Request) {
	subj, body, err := s.renderConfiguredAlert(s.emailData(sampleEvents()))
	if err == nil {
		err = s.sendMail("[Test] "+subj, body)
	}
	if err != nil {
		writeErr(w, 502, "Échec de l'envoi : "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handlePreviewEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Subject string `json:"subject"`
		Mode    string `json:"mode"`
		HTML    string `json:"html"`
		Blocks  string `json:"blocks"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Subject == "" {
		req.Subject = defaultSubject
	}
	if req.HTML == "" {
		req.HTML = defaultEmailHTML
	}
	if req.Blocks == "" {
		req.Blocks = defaultEmailBlocks
	}
	subj, body, err := s.renderAlert(req.Subject, req.Mode, req.HTML, req.Blocks, s.emailData(sampleEvents()))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"subject": subj, "html": body})
}

func (s *Server) handleVacuum(w http.ResponseWriter, r *http.Request) {
	s.cleanup()
	if _, err := s.db.Exec(`VACUUM`); err != nil {
		serverErr(w, err)
		return
	}
	s.handleGetSettings(w, r)
}

func (s *Server) cleanup() {
	days := func(k string) int64 {
		n, _ := strconv.Atoi(s.getSetting(k, settingDefs[k]))
		return time.Now().Add(-time.Duration(max(n, 1)) * 24 * time.Hour).Unix()
	}
	for _, q := range []struct {
		sql string
		arg int64
	}{
		{`DELETE FROM host_metrics WHERE ts<?`, days("retention_metrics_days")},
		{`DELETE FROM monitor_results WHERE ts<?`, days("retention_results_days") * 1000},
		{`DELETE FROM monitor_daily WHERE day<?`, days("retention_daily_days")},
		{`DELETE FROM host_daily WHERE day<?`, days("retention_daily_days")},
		{`DELETE FROM sessions WHERE expires_at<?`, time.Now().Unix()},
	} {
		if res, err := s.db.Exec(q.sql, q.arg); err != nil {
			slog.Error("retention", "err", err)
		} else if n, _ := res.RowsAffected(); n > 0 {
			slog.Info("retention", "query", q.sql, "deleted", n)
		}
	}
	s.db.Exec(`PRAGMA optimize`)
	s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
}

func (s *Server) runRetention(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		s.cleanup()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func overallStatus(statuses []string) string {
	worst := StatusOperational
	for _, st := range statuses {
		if statusRank(st) > statusRank(worst) {
			worst = st
		}
	}
	return worst
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	mons, err := s.loadMonitors("WHERE enabled=1")
	if err == nil {
		err = s.attachDays(mons, 90)
	}
	if err != nil {
		serverErr(w, err)
		return
	}
	var statuses []string
	for _, h := range hosts {
		statuses = append(statuses, h.Status)
	}
	for _, m := range mons {
		statuses = append(statuses, m.Status)
	}
	// Latency of up to six monitors over 24h for the overview chart.
	series := []map[string]any{}
	for _, m := range mons {
		if len(series) == 6 {
			break
		}
		if m.Type == "ssl" {
			continue
		}
		sr, err := s.latencySeries(m.ID, 24*time.Hour, 5*60*1000)
		if err != nil {
			serverErr(w, err)
			return
		}
		sr["name"] = m.Name
		series = append(series, sr)
	}
	writeJSON(w, 200, map[string]any{"status": overallStatus(statuses), "hosts": withoutPackages(hosts), "monitors": mons, "latency": series})
}
