package main

// SMART disk health. The agent sends normalised raw values (see rust-agent/src/smart.rs);
// the verdict is computed here, on read, so thresholds can evolve without redeploying agents.

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"
)

type smartDisk struct {
	Name           string   `json:"name"`
	Model          string   `json:"model"`
	Serial         string   `json:"serial"`
	Kind           string   `json:"kind"` // hdd, ssd, nvme
	CapacityBytes  uint64   `json:"capacity_bytes"`
	SmartPassed    *bool    `json:"smart_passed"`
	TemperatureC   *float64 `json:"temperature_c"`
	PowerOnHours   *float64 `json:"power_on_hours"`
	PowerCycles    *float64 `json:"power_cycles"`
	Reallocated    *float64 `json:"reallocated"`
	Pending        *float64 `json:"pending"`
	OfflineUncorr  *float64 `json:"offline_uncorrectable"`
	ReportedUncorr *float64 `json:"reported_uncorrect"`
	CRCErrors      *float64 `json:"crc_errors"`
	WearUsedPct    *float64 `json:"wear_used_pct"`
	SparePct       *float64 `json:"available_spare_pct"`
	SpareThreshPct *float64 `json:"spare_threshold_pct"`
	MediaErrors    *float64 `json:"media_errors"`
	CriticalWarn   *float64 `json:"critical_warning"`
	WrittenBytes   *float64 `json:"data_written_bytes"`
}

type smartReport struct {
	Disks       []smartDisk `json:"disks"`
	Error       string      `json:"error,omitempty"` // e.g. smartctl missing
	CollectedAt int64       `json:"collected_at"`
}

// Disk health levels, best to worst.
const (
	DiskGood    = "good"
	DiskWatch   = "watch"
	DiskReplace = "replace"
	DiskFailing = "failing"
)

var diskRank = map[string]int{DiskGood: 0, DiskWatch: 1, DiskReplace: 2, DiskFailing: 3}

type diskHealth struct {
	smartDisk
	Health       string   `json:"health"`
	Score        int      `json:"score"` // 0-100
	Usable       bool     `json:"usable"`
	Summary      string   `json:"summary"`
	Reasons      []string `json:"reasons"`
	LifeLeftDays *int     `json:"life_left_days"` // estimate; nil when it cannot be estimated
	LifeBasis    string   `json:"life_basis"`
}

// hddDesignHours is the usual service life of a hard drive running 24/7 (5 years).
const hddDesignHours = 5 * 365 * 24

func v(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func analyzeDisk(d smartDisk) diskHealth {
	h := diskHealth{smartDisk: d, Health: DiskGood, Reasons: []string{}}
	raise := func(level, reason string) {
		if diskRank[level] > diskRank[h.Health] {
			h.Health = level
		}
		h.Reasons = append(h.Reasons, reason)
	}
	ssd := d.Kind != "hdd"

	if d.SmartPassed != nil && !*d.SmartPassed {
		raise(DiskFailing, "Le disque signale lui-même une défaillance (test SMART global échoué)")
	}
	if v(d.CriticalWarn) != 0 {
		raise(DiskFailing, "Avertissement critique NVMe actif")
	}
	if d.SparePct != nil && d.SpareThreshPct != nil && *d.SparePct <= *d.SpareThreshPct {
		raise(DiskFailing, fmt.Sprintf("Réserve de cellules épuisée (%.0f %%, seuil %.0f %%)", *d.SparePct, *d.SpareThreshPct))
	}
	if n := v(d.Pending); n > 0 {
		raise(DiskReplace, fmt.Sprintf("%.0f secteur(s) illisible(s) en attente de réallocation", n))
	}
	if n := v(d.OfflineUncorr); n > 0 {
		raise(DiskReplace, fmt.Sprintf("%.0f secteur(s) irrécupérable(s)", n))
	}
	if n := v(d.ReportedUncorr); n > 0 {
		raise(DiskReplace, fmt.Sprintf("%.0f erreur(s) de lecture non corrigée(s)", n))
	}
	if n := v(d.MediaErrors); n > 0 {
		raise(DiskReplace, fmt.Sprintf("%.0f erreur(s) d'intégrité du support", n))
	}
	switch n := v(d.Reallocated); {
	case n >= 100:
		raise(DiskReplace, fmt.Sprintf("%.0f secteurs déjà remplacés : la surface se dégrade", n))
	case n > 0:
		raise(DiskWatch, fmt.Sprintf("%.0f secteur(s) remplacé(s) : à surveiller", n))
	}
	if w := d.WearUsedPct; w != nil {
		switch {
		case *w >= 90:
			raise(DiskReplace, fmt.Sprintf("Usure de %.0f %% : fin de vie proche", *w))
		case *w >= 70:
			raise(DiskWatch, fmt.Sprintf("Usure de %.0f %%", *w))
		}
	}
	if n := v(d.CRCErrors); n > 0 {
		raise(DiskWatch, fmt.Sprintf("%.0f erreur(s) de transmission : vérifiez le câble SATA", n))
	}
	if t := d.TemperatureC; t != nil {
		limit := 50.0
		if ssd {
			limit = 70
		}
		if *t >= limit {
			raise(DiskWatch, fmt.Sprintf("Température élevée : %.0f °C", *t))
		}
	}
	poh := v(d.PowerOnHours)
	if !ssd && poh >= hddDesignHours {
		raise(DiskWatch, fmt.Sprintf("%.1f ans de fonctionnement : au-delà de la durée de vie habituelle", poh/8760))
	}

	// Score: wear (SSD) or age (HDD), minus a penalty per problem level.
	score := 100.0
	if ssd && d.WearUsedPct != nil {
		score = 100 - *d.WearUsedPct
	} else if !ssd {
		score = 100 - math.Min(40, poh/hddDesignHours*40)
	}
	score -= map[string]float64{DiskGood: 0, DiskWatch: 15, DiskReplace: 50, DiskFailing: 90}[h.Health]
	h.Score = int(math.Max(0, math.Min(100, math.Round(score))))
	h.Usable = diskRank[h.Health] <= diskRank[DiskWatch]

	days := func(hours float64) *int {
		n := int(math.Max(0, hours/24))
		return &n
	}
	switch {
	case diskRank[h.Health] >= diskRank[DiskReplace]:
		h.LifeLeftDays, h.LifeBasis = days(0), "Remplacement conseillé dès maintenant"
	case ssd && d.WearUsedPct != nil && *d.WearUsedPct > 0 && poh > 0:
		// Extrapolates the wear rate observed so far, assuming the same usage.
		rate := *d.WearUsedPct / poh
		h.LifeLeftDays = days((100 - *d.WearUsedPct) / rate)
		h.LifeBasis = fmt.Sprintf("Usure de %.0f %% en %.0f jours de fonctionnement, à usage constant", *d.WearUsedPct, poh/24)
	case ssd:
		h.LifeBasis = "Usure encore nulle : estimation impossible pour le moment"
	case poh > 0:
		h.LifeLeftDays = days(hddDesignHours - poh)
		h.LifeBasis = "Durée de vie habituelle d'un disque dur : 5 ans en fonctionnement continu"
	default:
		h.LifeBasis = "Heures de fonctionnement inconnues"
	}

	if h.Health == DiskGood && h.LifeLeftDays != nil && *h.LifeLeftDays < 365 {
		raise(DiskWatch, "Fin de vie estimée dans moins d'un an : prévoyez le remplacement")
		h.Score = min(h.Score, 85)
		h.Usable = true
	}

	h.Summary = map[string]string{
		DiskGood:    "Bon état, utilisable sans réserve.",
		DiskWatch:   "Utilisable, à surveiller.",
		DiskReplace: "Encore lisible mais à remplacer rapidement : sauvegardez les données.",
		DiskFailing: "Défaillance en cours : sauvegardez et remplacez immédiatement.",
	}[h.Health]
	return h
}

func analyzeReport(raw string) ([]diskHealth, *smartReport) {
	var rep smartReport
	if json.Unmarshal([]byte(raw), &rep) != nil || rep.CollectedAt == 0 {
		return nil, nil
	}
	out := make([]diskHealth, 0, len(rep.Disks))
	for _, d := range rep.Disks {
		out = append(out, analyzeDisk(d))
	}
	return out, &rep
}

// storeSmart saves a report and alerts when a disk gets worse than "watch".
func (s *Server) storeSmart(id int64, hostName string, rep *smartReport) error {
	if len(rep.Disks) > 64 {
		rep.Disks = rep.Disks[:64]
	}
	rep.CollectedAt = time.Now().Unix()
	var prevRaw string
	s.db.QueryRow(`SELECT smart FROM hosts WHERE id=?`, id).Scan(&prevRaw)
	prev, _ := analyzeReport(prevRaw)
	before := map[string]string{}
	for _, d := range prev {
		before[d.Serial+d.Name] = d.Health
	}
	b, _ := json.Marshal(rep)
	if _, err := s.db.Exec(`UPDATE hosts SET smart=? WHERE id=?`, string(b), id); err != nil {
		return err
	}
	for _, d := range rep.Disks {
		h := analyzeDisk(d)
		old, seen := before[d.Serial+d.Name]
		level := s.getSetting("notify_smart_level", DiskReplace)
		if level != "off" && diskRank[h.Health] >= diskRank[level] && (!seen || diskRank[h.Health] > diskRank[old]) {
			s.notifier.add(Event{Kind: KindDisk, Name: hostName + " · " + d.Model + " (" + d.Name + ")", Message: h.Summary + " " + joinReasons(h.Reasons), At: time.Now()})
		}
	}
	return nil
}

func joinReasons(r []string) string {
	out := ""
	for i, x := range r {
		if i > 0 {
			out += " ; "
		}
		out += x
	}
	return out
}

type hostDisks struct {
	HostID      int64        `json:"host_id"`
	Host        string       `json:"host"`
	Disks       []diskHealth `json:"disks"`
	Error       string       `json:"error,omitempty"`
	CollectedAt int64        `json:"collected_at"`
}

func (s *Server) loadDisks() ([]hostDisks, error) {
	rows, err := s.db.Query(`SELECT id, name, smart FROM hosts ORDER BY name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []hostDisks{}
	for rows.Next() {
		var hd hostDisks
		var raw string
		if err := rows.Scan(&hd.HostID, &hd.Host, &raw); err != nil {
			return nil, err
		}
		disks, rep := analyzeReport(raw)
		if rep == nil {
			continue
		}
		hd.Disks, hd.Error, hd.CollectedAt = disks, rep.Error, rep.CollectedAt
		out = append(out, hd)
	}
	return out, rows.Err()
}

func (s *Server) handleDisks(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDisks()
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}
