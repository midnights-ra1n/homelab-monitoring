package main

// Monthly infrastructure report, built from the daily rollups (monitor_daily, host_daily)
// so it works after raw metrics are purged. Sent by e-mail on the 1st if enabled.

import (
	"bytes"
	"context"
	"html/template"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type reportMonitor struct {
	ID           int64    `json:"id"`
	Name         string   `json:"name"`
	Type         string   `json:"type"`
	Uptime       *float64 `json:"uptime"` // 0-1, nil without data
	AvgLatencyMs *float64 `json:"avg_latency_ms"`
	IncidentDays int      `json:"incident_days"` // days with a partial or major outage
	Worst        string   `json:"worst"`
}

type reportHost struct {
	ID           int64    `json:"id"`
	Name         string   `json:"name"`
	Availability *float64 `json:"availability"` // share of expected agent samples received, 0-1
	CPUAvg       *float64 `json:"cpu_avg"`
	MemAvg       *float64 `json:"mem_avg"`
}

type reportUpdates struct {
	HostID         int64  `json:"host_id"`
	Host           string `json:"host"`
	Pending        int    `json:"pending"`
	Security       int    `json:"security"`
	RebootRequired bool   `json:"reboot_required"`
	Images         int    `json:"images"` // Docker images to update
}

type MonthlyReport struct {
	Month          string          `json:"month"` // YYYY-MM
	From           int64           `json:"from"`
	To             int64           `json:"to"`
	Uptime         *float64        `json:"uptime"` // average of monitor uptimes
	HostAvail      *float64        `json:"host_availability"`
	IncidentDays   int             `json:"incident_days"`
	Monitors       []reportMonitor `json:"monitors"`
	Hosts          []reportHost    `json:"hosts"`
	Certificates   []Monitor       `json:"certificates_expiring"` // within 30 days of report generation
	PendingUpdates int             `json:"pending_updates"`
	SecurityUpd    int             `json:"security_updates"`
	DisksAttention []diskHealth    `json:"disks_attention"`
	Updates        []reportUpdates `json:"updates"`        // hosts with something to do, at generation time
	DockerUpdates  int             `json:"docker_updates"` // containers whose image has a newer version
	GeneratedAt    int64           `json:"generated_at"`
}

func parseMonth(s string) (time.Time, bool) {
	if s == "" {
		now := time.Now().UTC()
		return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -1, 0), true
	}
	t, err := time.Parse("2006-01", s)
	return t, err == nil
}

func (s *Server) monthlyReport(start time.Time) (*MonthlyReport, error) {
	end := start.AddDate(0, 1, 0)
	rep := &MonthlyReport{Month: start.Format("2006-01"), From: start.Unix(), To: end.Unix(), GeneratedAt: time.Now().Unix(),
		Monitors: []reportMonitor{}, Hosts: []reportHost{}, Certificates: []Monitor{}, DisksAttention: []diskHealth{}, Updates: []reportUpdates{}}

	rows, err := s.db.Query(`SELECT m.id, m.name, m.type, SUM(d.total), SUM(d.up), SUM(d.latency_sum), SUM(d.latency_n),
			SUM(CASE WHEN d.worst>=3 THEN 1 ELSE 0 END), MAX(d.worst)
		FROM monitors m LEFT JOIN monitor_daily d ON d.monitor_id=m.id AND d.day>=? AND d.day<?
		GROUP BY m.id ORDER BY m.name COLLATE NOCASE`, rep.From, rep.To)
	if err != nil {
		return nil, err
	}
	var upSum float64
	var upN int
	for rows.Next() {
		var m reportMonitor
		var total, up, latN, incid, worst *int64
		var latSum *float64
		if err := rows.Scan(&m.ID, &m.Name, &m.Type, &total, &up, &latSum, &latN, &incid, &worst); err != nil {
			rows.Close()
			return nil, err
		}
		m.Worst = StatusUnknown
		if total != nil && *total > 0 {
			u := float64(*up) / float64(*total)
			m.Uptime = &u
			upSum += u
			upN++
			m.Worst = rankStatus[min(max(int(*worst), 0), len(rankStatus)-1)]
		}
		if latN != nil && *latN > 0 {
			l := *latSum / float64(*latN)
			m.AvgLatencyMs = &l
		}
		if incid != nil {
			m.IncidentDays = int(*incid)
			rep.IncidentDays += m.IncidentDays
		}
		rep.Monitors = append(rep.Monitors, m)
	}
	rows.Close()
	if upN > 0 {
		u := upSum / float64(upN)
		rep.Uptime = &u
	}

	// Expected samples assume the current agent interval, over the part of the month
	// during which the host existed (a host added mid-month is not penalised).
	interval := float64(s.agentInterval())
	rows, err = s.db.Query(`SELECT h.id, h.name, h.created_at, SUM(d.samples), SUM(d.cpu_sum), SUM(d.mem_sum)
		FROM hosts h LEFT JOIN host_daily d ON d.host_id=h.id AND d.day>=? AND d.day<?
		GROUP BY h.id ORDER BY h.name COLLATE NOCASE`, rep.From, rep.To)
	if err != nil {
		return nil, err
	}
	var avSum float64
	var avN int
	for rows.Next() {
		var h reportHost
		var created int64
		var samples *int64
		var cpu, mem *float64
		if err := rows.Scan(&h.ID, &h.Name, &created, &samples, &cpu, &mem); err != nil {
			rows.Close()
			return nil, err
		}
		window := float64(min(end.Unix(), time.Now().Unix()) - max(start.Unix(), created))
		if samples != nil && *samples > 0 && window > 0 {
			a := min(1, float64(*samples)*interval/window)
			c, m := *cpu/float64(*samples), *mem/float64(*samples)
			h.Availability, h.CPUAvg, h.MemAvg = &a, &c, &m
			avSum += a
			avN++
		}
		rep.Hosts = append(rep.Hosts, h)
	}
	rows.Close()
	if avN > 0 {
		a := avSum / float64(avN)
		rep.HostAvail = &a
	}

	mons, err := s.loadMonitors("WHERE cert_expires_at IS NOT NULL AND cert_expires_at < ?", time.Now().AddDate(0, 0, 30).Unix())
	if err != nil {
		return nil, err
	}
	rep.Certificates = append(rep.Certificates, mons...)
	hosts, err := s.loadHosts("")
	if err != nil {
		return nil, err
	}
	for _, h := range hosts {
		u := reportUpdates{HostID: h.ID, Host: h.Name}
		if h.Updates != nil {
			rep.PendingUpdates += h.Updates.Pending
			rep.SecurityUpd += h.Updates.Security
			u.Pending, u.Security, u.RebootRequired = h.Updates.Pending, h.Updates.Security, h.Updates.RebootRequired
		}
		if h.Docker != nil {
			rep.DockerUpdates += h.Docker.UpdatesAvailable
			u.Images = h.Docker.UpdatesAvailable
		}
		if u.Pending > 0 || u.RebootRequired || u.Images > 0 {
			rep.Updates = append(rep.Updates, u)
		}
	}
	disks, err := s.loadDisks()
	if err != nil {
		return nil, err
	}
	for _, hd := range disks {
		for _, d := range hd.Disks {
			if d.Health != DiskGood {
				d.Name = hd.Host + " · " + d.Name
				rep.DisksAttention = append(rep.DisksAttention, d)
			}
		}
	}
	sort.SliceStable(rep.Monitors, func(i, j int) bool { return pctOr(rep.Monitors[i].Uptime) < pctOr(rep.Monitors[j].Uptime) })
	return rep, nil
}

func pctOr(p *float64) float64 {
	if p == nil {
		return 2 // no data sorts last
	}
	return *p
}

func (s *Server) handleMonthlyReport(w http.ResponseWriter, r *http.Request) {
	start, ok := parseMonth(r.URL.Query().Get("month"))
	if !ok {
		writeErr(w, 400, "Le mois doit être au format AAAA-MM")
		return
	}
	rep, err := s.monthlyReport(start)
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, rep)
}

func (s *Server) handleSendMonthlyReport(w http.ResponseWriter, r *http.Request) {
	start, ok := parseMonth(r.URL.Query().Get("month"))
	if !ok {
		writeErr(w, 400, "Le mois doit être au format AAAA-MM")
		return
	}
	if err := s.sendMonthlyReport(start); err != nil {
		writeErr(w, 502, "Échec de l'envoi : "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

var frMonths = []string{"janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"}

var reportTpl = template.Must(template.New("report").Funcs(template.FuncMap{
	"pct": func(p *float64) string {
		if p == nil {
			return "—"
		}
		return frNum(*p*100, 2) + " %"
	},
	"ms": func(p *float64) string {
		if p == nil {
			return "—"
		}
		return frNum(*p, 0) + " ms"
	},
	"days": func(p *int) string {
		if p == nil {
			return "—"
		}
		return frNum(float64(*p), 0) + " j"
	},
	"date": func(p *int64) string {
		if p == nil {
			return "—"
		}
		return time.Unix(*p, 0).In(localTZ()).Format("02/01/2006")
	},
}).Parse(`<!doctype html><html lang="fr"><body style="margin:0;background:#f2f6f8;font-family:Geist,system-ui,-apple-system,'Segoe UI',sans-serif;color:#131b1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #d8dfe3;border-radius:6px">
<tr><td style="padding:16px;border-bottom:1px solid #e7ecef"><div style="font-size:18px;font-weight:600">Rapport mensuel · {{.Label}}</div><div style="font-size:13px;color:#546066">{{.Title}}</div></td></tr>
<tr><td style="padding:16px"><table width="100%" cellpadding="0" cellspacing="0"><tr>
<td><div style="font-size:13px;color:#546066">Disponibilité des sondes</div><div style="font-size:24px;font-weight:600">{{pct .R.Uptime}}</div></td>
<td><div style="font-size:13px;color:#546066">Disponibilité des hôtes</div><div style="font-size:24px;font-weight:600">{{pct .R.HostAvail}}</div></td>
<td><div style="font-size:13px;color:#546066">Jours d'incident</div><div style="font-size:24px;font-weight:600">{{.R.IncidentDays}}</div></td>
</tr></table></td></tr>
<tr><td style="padding:0 16px 16px"><div style="font-size:14px;font-weight:600;margin-bottom:8px">Sondes</div>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse">
<tr style="background:#f8fafc;color:#546066"><td>Nom</td><td align="right">Disponibilité</td><td align="right">Latence moy.</td><td align="right">Jours d'incident</td></tr>
{{range .R.Monitors}}<tr style="border-top:1px solid #e7ecef"><td>{{.Name}}</td><td align="right">{{pct .Uptime}}</td><td align="right">{{ms .AvgLatencyMs}}</td><td align="right">{{.IncidentDays}}</td></tr>{{end}}
</table></td></tr>
<tr><td style="padding:0 16px 16px"><div style="font-size:14px;font-weight:600;margin-bottom:8px">Hôtes</div>
<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse">
<tr style="background:#f8fafc;color:#546066"><td>Nom</td><td align="right">Disponibilité</td><td align="right">CPU moy.</td><td align="right">Mémoire moy.</td></tr>
{{range .R.Hosts}}<tr style="border-top:1px solid #e7ecef"><td>{{.Name}}</td><td align="right">{{pct .Availability}}</td><td align="right">{{if .CPUAvg}}{{printf "%.0f" .CPUAvg}} %{{else}}—{{end}}</td><td align="right">{{if .MemAvg}}{{printf "%.0f" .MemAvg}} %{{else}}—{{end}}</td></tr>{{end}}
</table></td></tr>
<tr><td style="padding:0 16px 16px;font-size:13px">
<div style="font-size:14px;font-weight:600;margin-bottom:8px">Mises à jour</div>
<div>{{.R.PendingUpdates}} paquet(s) en attente dont {{.R.SecurityUpd}} de sécurité{{if .R.DockerUpdates}} · {{.R.DockerUpdates}} image(s) Docker à mettre à jour{{end}}</div>
{{if .R.Updates}}<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;margin-top:8px">
<tr style="background:#f8fafc;color:#546066"><td>Hôte</td><td align="right">Paquets</td><td align="right">Sécurité</td><td align="right">Images Docker</td><td>Redémarrage</td></tr>
{{range .R.Updates}}<tr style="border-top:1px solid #e7ecef"><td>{{.Host}}</td><td align="right">{{.Pending}}</td><td align="right"{{if .Security}} style="color:#9d3533;font-weight:600"{{end}}>{{.Security}}</td><td align="right">{{.Images}}</td><td>{{if .RebootRequired}}<span style="color:#8a4e00;font-weight:600">Requis</span>{{else}}Non{{end}}</td></tr>{{end}}
</table>{{end}}
</td></tr>
<tr><td style="padding:0 16px 16px;font-size:13px">
<div style="font-size:14px;font-weight:600;margin-bottom:8px">Santé des disques (SMART)</div>
{{if .R.DisksAttention}}<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse">
<tr style="background:#f8fafc;color:#546066"><td>Disque</td><td>État</td><td align="right">Durée restante estimée</td></tr>
{{range .R.DisksAttention}}<tr style="border-top:1px solid #e7ecef"><td>{{.Name}}<div style="color:#67727a;font-size:12px">{{.Model}}</div></td><td>{{.Summary}}</td><td align="right">{{days .LifeLeftDays}}</td></tr>{{end}}
</table>{{else}}<div>Tous les disques suivis sont en bon état.</div>{{end}}
{{if .R.Certificates}}<div style="margin-top:12px"><strong>Certificats expirant sous 30 jours :</strong> {{range $i, $c := .R.Certificates}}{{if $i}}, {{end}}{{$c.Name}} ({{date $c.CertExpires}}){{end}}</div>{{end}}
</td></tr>
<tr><td style="padding:12px 16px;font-size:12px;color:#67727a;border-top:1px solid #e7ecef">{{if .URL}}<a href="{{.URL}}/reports" style="color:#16695a">Voir le rapport complet</a>{{end}}</td></tr>
</table></td></tr></table></body></html>`))

func frNum(f float64, decimals int) string {
	return strings.Replace(strconv.FormatFloat(f, 'f', decimals, 64), ".", ",", 1)
}

func (s *Server) sendMonthlyReport(start time.Time) error {
	rep, err := s.monthlyReport(start)
	if err != nil {
		return err
	}
	label := frMonths[start.Month()-1] + " " + start.Format("2006")
	var b bytes.Buffer
	if err := reportTpl.Execute(&b, map[string]any{"R": rep, "Label": label, "Title": s.getSetting("status_title", "Homelab"), "URL": s.cfg.PublicURL}); err != nil {
		return err
	}
	return s.sendMail("[Rapport] "+label+" · disponibilité "+pctString(rep.Uptime), b.String())
}

func pctString(p *float64) string {
	if p == nil {
		return "sans données"
	}
	return frNum(*p*100, 2) + " %"
}

// runReports sends last month's report once, on the 1st after 08:00 in the configured time zone.
func (s *Server) runReports(ctx context.Context) {
	t := time.NewTicker(30 * time.Minute)
	defer t.Stop()
	for {
		now := time.Now().In(localTZ())
		if s.getSetting("report_monthly_enabled", "false") == "true" && s.getSetting("smtp_enabled", "false") == "true" && now.Day() == 1 && now.Hour() >= 8 {
			start, _ := parseMonth("")
			if s.getSetting("report_last_sent", "") != start.Format("2006-01") {
				if err := s.sendMonthlyReport(start); err != nil {
					slog.Error("monthly report", "err", err)
				} else {
					s.setSetting("report_last_sent", start.Format("2006-01"))
					slog.Info("monthly report sent", "month", start.Format("2006-01"))
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
