package main

// Energy report of the Meross plugs, from monitor_daily.energy_wh, so it survives the purge of raw results.

import (
	"bytes"
	"encoding/csv"
	"html/template"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

type energyPlug struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	TotalWh    float64    `json:"total_wh"`
	AvgDayWh   *float64   `json:"avg_day_wh"`
	AvgWeekWh  *float64   `json:"avg_week_wh"`
	AvgMonthWh *float64   `json:"avg_month_wh"`
	Daily      []*float64 `json:"daily"` // Wh per day, aligned on EnergyReport.Days, nil without readings
}

type EnergyReport struct {
	From       int64        `json:"from"`
	To         int64        `json:"to"`   // exclusive
	Days       []int64      `json:"days"` // unix seconds, UTC midnight
	TotalWh    float64      `json:"total_wh"`
	AvgDayWh   *float64     `json:"avg_day_wh"`
	AvgWeekWh  *float64     `json:"avg_week_wh"`
	AvgMonthWh *float64     `json:"avg_month_wh"`
	Plugs      []energyPlug `json:"plugs"`
}

// averages derive week and month from the mean measured day, so partial weeks or months do not drag them down.
func averages(total float64, days int) (d, w, m *float64) {
	if days == 0 {
		return nil, nil, nil
	}
	a := total / float64(days)
	ww, mm := a*7, a*30.44
	return &a, &ww, &mm
}

func (s *Server) energyReport(from, to int64) (*EnergyReport, error) {
	rep := &EnergyReport{From: from, To: to, Days: []int64{}, Plugs: []energyPlug{}}
	idx := map[int64]int{}
	for d := from; d < to; d += 86400 {
		idx[d] = len(rep.Days)
		rep.Days = append(rep.Days, d)
	}
	mons, err := s.loadMonitors(`WHERE type='meross'`)
	if err != nil {
		return nil, err
	}
	pos := map[int64]int{}
	for _, m := range mons {
		pos[m.ID] = len(rep.Plugs)
		rep.Plugs = append(rep.Plugs, energyPlug{ID: m.ID, Name: m.Name, Daily: make([]*float64, len(rep.Days))})
	}
	rows, err := s.db.Query(`SELECT d.monitor_id, d.day, d.energy_wh FROM monitor_daily d JOIN monitors m ON m.id=d.monitor_id
		WHERE m.type='meross' AND d.day>=? AND d.day<?`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	measured := map[int64]bool{} // days with at least one plug reading, for the global average
	for rows.Next() {
		var id, day int64
		var wh float64
		if err := rows.Scan(&id, &day, &wh); err != nil {
			return nil, err
		}
		i, ok := idx[day]
		if !ok {
			continue
		}
		p := &rep.Plugs[pos[id]]
		p.Daily[i] = &wh
		p.TotalWh += wh
		rep.TotalWh += wh
		measured[day] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range rep.Plugs {
		p := &rep.Plugs[i]
		n := 0
		for _, v := range p.Daily {
			if v != nil {
				n++
			}
		}
		p.AvgDayWh, p.AvgWeekWh, p.AvgMonthWh = averages(p.TotalWh, n)
	}
	rep.AvgDayWh, rep.AvgWeekWh, rep.AvgMonthWh = averages(rep.TotalWh, len(measured))
	return rep, nil
}

// lastDays covers the n last days, today included.
func lastDays(r *http.Request) (int64, int64, bool) {
	n := 30
	if v := r.URL.Query().Get("days"); v != "" {
		var err error
		if n, err = strconv.Atoi(v); err != nil || n < 1 || n > 3650 {
			return 0, 0, false
		}
	}
	to := time.Now().Unix()/86400*86400 + 86400
	return to - int64(n)*86400, to, true
}

func (s *Server) handleEnergyReport(w http.ResponseWriter, r *http.Request) {
	from, to, ok := lastDays(r)
	if !ok {
		writeErr(w, 400, "days doit être compris entre 1 et 3650")
		return
	}
	rep, err := s.energyReport(from, to)
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, rep)
}

func (s *Server) handleEnergyCSV(w http.ResponseWriter, r *http.Request) {
	from, to, ok := lastDays(r)
	if !ok {
		writeErr(w, 400, "days doit être compris entre 1 et 3650")
		return
	}
	rep, err := s.energyReport(from, to)
	if err != nil {
		serverErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="hlm-consommation-`+time.Now().Format("2006-01-02")+`.csv"`)
	cw := csv.NewWriter(w)
	cw.Write([]string{"date", "prise", "kwh"})
	for _, p := range rep.Plugs {
		for i, v := range p.Daily {
			if v != nil {
				// A leading quote stops spreadsheet formula injection through a plug name.
				name := p.Name
				if name != "" && (name[0] == '=' || name[0] == '+' || name[0] == '-' || name[0] == '@') {
					name = "'" + name
				}
				cw.Write([]string{time.Unix(rep.Days[i], 0).UTC().Format("2006-01-02"), name, strconv.FormatFloat(*v/1000, 'f', 3, 64)})
			}
		}
	}
	cw.Flush()
}

func (s *Server) handleSendEnergyReport(w http.ResponseWriter, r *http.Request) {
	from, to, ok := lastDays(r)
	if !ok {
		writeErr(w, 400, "days doit être compris entre 1 et 3650")
		return
	}
	if err := s.sendEnergyReport(from, to); err != nil {
		writeErr(w, 502, "Échec de l'envoi : "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func kwh(p *float64) string {
	if p == nil {
		return "—"
	}
	return frNum(*p/1000, 2) + " kWh"
}

var energyTpl = template.Must(template.New("energy").Funcs(template.FuncMap{"kwh": kwh, "kwhv": func(v float64) string { return kwh(&v) }}).Parse(`<!doctype html><html lang="fr"><body style="margin:0;background:#f2f6f8;font-family:Geist,system-ui,-apple-system,'Segoe UI',sans-serif;color:#131b1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #d8dfe3;border-radius:6px">
<tr><td style="padding:16px;border-bottom:1px solid #e7ecef"><div style="font-size:18px;font-weight:600">Consommation électrique · {{.Label}}</div><div style="font-size:13px;color:#546066">{{.Title}}</div></td></tr>
<tr><td style="padding:16px"><table width="100%" cellpadding="0" cellspacing="0"><tr>
<td><div style="font-size:13px;color:#546066">Total</div><div style="font-size:22px;font-weight:600">{{kwhv .R.TotalWh}}</div></td>
<td><div style="font-size:13px;color:#546066">Moyenne / jour</div><div style="font-size:22px;font-weight:600">{{kwh .R.AvgDayWh}}</div></td>
<td><div style="font-size:13px;color:#546066">/ semaine</div><div style="font-size:22px;font-weight:600">{{kwh .R.AvgWeekWh}}</div></td>
<td><div style="font-size:13px;color:#546066">/ mois</div><div style="font-size:22px;font-weight:600">{{kwh .R.AvgMonthWh}}</div></td>
</tr></table></td></tr>
<tr><td style="padding:0 16px 16px"><table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse">
<tr style="background:#f8fafc;color:#546066"><td>Prise</td><td align="right">Total</td><td align="right">/ jour</td><td align="right">/ semaine</td><td align="right">/ mois</td></tr>
{{range .R.Plugs}}<tr style="border-top:1px solid #e7ecef"><td>{{.Name}}</td><td align="right">{{kwhv .TotalWh}}</td><td align="right">{{kwh .AvgDayWh}}</td><td align="right">{{kwh .AvgWeekWh}}</td><td align="right">{{kwh .AvgMonthWh}}</td></tr>{{end}}
</table></td></tr>
<tr><td style="padding:12px 16px;font-size:12px;color:#67727a;border-top:1px solid #e7ecef">{{if .URL}}<a href="{{.URL}}/energy" style="color:#16695a">Voir le détail</a>{{end}}</td></tr>
</table></td></tr></table></body></html>`))

func (s *Server) sendEnergyReport(from, to int64) error {
	rep, err := s.energyReport(from, to)
	if err != nil {
		return err
	}
	d := func(u int64) string { return time.Unix(u, 0).UTC().Format("02/01/2006") }
	label := d(from)
	if to-from > 86400 {
		label = "du " + d(from) + " au " + d(to-86400)
	}
	var b bytes.Buffer
	if err := energyTpl.Execute(&b, map[string]any{"R": rep, "Label": label, "Title": s.getSetting("status_title", "Homelab"), "URL": s.cfg.PublicURL}); err != nil {
		return err
	}
	return s.sendMail("[Consommation] "+label+" · "+kwh(&rep.TotalWh), b.String())
}

// energyPeriod returns the period to e-mail now for the "report_energy" frequency, and its key.
func energyPeriod(freq string, now time.Time) (from, to int64, key string, due bool) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if now.Hour() < 8 {
		return 0, 0, "", false
	}
	switch freq {
	case "daily":
		return today.AddDate(0, 0, -1).Unix(), today.Unix(), "d" + today.Format("2006-01-02"), true
	case "weekly":
		if now.Weekday() == time.Monday {
			return today.AddDate(0, 0, -7).Unix(), today.Unix(), "w" + today.Format("2006-01-02"), true
		}
	case "monthly":
		if now.Day() == 1 {
			return today.AddDate(0, -1, 0).Unix(), today.Unix(), "m" + today.Format("2006-01"), true
		}
	}
	return 0, 0, "", false
}

func (s *Server) maybeSendEnergyReport() {
	from, to, key, due := energyPeriod(s.getSetting("report_energy", "off"), time.Now().In(localTZ()))
	if !due || s.getSetting("smtp_enabled", "false") != "true" || s.getSetting("report_energy_last_sent", "") == key {
		return
	}
	if err := s.sendEnergyReport(from, to); err != nil {
		slog.Error("energy report", "err", err)
		return
	}
	s.setSetting("report_energy_last_sent", key)
}
