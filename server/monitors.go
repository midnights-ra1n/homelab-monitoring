package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Statuses follow Atlassian Statuspage / Better Stack wording.
const (
	StatusOperational = "operational"
	StatusDegraded    = "degraded"
	StatusMaintenance = "maintenance"
	StatusMinor       = "minor_outage"
	StatusMajor       = "major_outage"
	StatusUnknown     = "unknown"
)

// statusRank orders statuses from best to worst; used for daily rollups and the overall status.
func statusRank(s string) int {
	switch s {
	case StatusOperational:
		return 0
	case StatusMaintenance:
		return 1
	case StatusDegraded:
		return 2
	case StatusMinor:
		return 3
	case StatusMajor:
		return 4
	}
	return -1
}

var rankStatus = []string{StatusOperational, StatusMaintenance, StatusDegraded, StatusMinor, StatusMajor}

type MonitorConfig struct {
	Method           string `json:"method,omitempty"`          // http: GET or HEAD
	ExpectedStatus   string `json:"expected_status,omitempty"` // http: "200-399" or "200,204"
	Keyword          string `json:"keyword,omitempty"`         // http: body must contain it
	IgnoreTLS        bool   `json:"ignore_tls,omitempty"`      // http: accept self-signed certificates
	CheckSSL         bool   `json:"check_ssl,omitempty"`       // http: track the certificate expiry of an https:// URL
	DegradedMs       int    `json:"degraded_ms,omitempty"`     // http/tcp/dns: slower than this = degraded
	DNSServer        string `json:"dns_server,omitempty"`      // dns: ip[:port], empty = system resolver
	RecordType       string `json:"record_type,omitempty"`     // dns: A, AAAA, CNAME, MX, TXT, NS
	Expected         string `json:"expected,omitempty"`        // dns: an answer must contain it
	WarnDays         int    `json:"warn_days,omitempty"`       // ssl / check_ssl: e-mail this many days before expiry
	FailureThreshold int    `json:"failure_threshold,omitempty"`
}

type Monitor struct {
	ID          int64         `json:"id"`
	Name        string        `json:"name"`
	Type        string        `json:"type"`
	Target      string        `json:"target"`
	IntervalS   int           `json:"interval_s"`
	TimeoutS    int           `json:"timeout_s"`
	Config      MonitorConfig `json:"config"`
	Enabled     bool          `json:"enabled"`
	Maintenance bool          `json:"maintenance"`
	Public      bool          `json:"public"`
	Status      string        `json:"status"`
	Message     string        `json:"message"`
	LatencyMs   *float64      `json:"latency_ms"`
	LastCheck   int64         `json:"last_check"`
	CertExpires *int64        `json:"cert_expires_at"` // unix seconds, for ssl monitors and http with check_ssl
	Days        []Day         `json:"days,omitempty"`

	certAlertedFor int64 // NotAfter of the certificate already reported, so each certificate warns once
}

type Day struct {
	Day    int64    `json:"day"` // unix seconds, UTC midnight
	Uptime *float64 `json:"uptime"`
	Worst  string   `json:"worst"`
}

func (c *MonitorConfig) threshold() int {
	if c.FailureThreshold < 1 {
		return 2
	}
	return c.FailureThreshold
}

func (m *Monitor) validate() string {
	var msg string
	if m.Name, msg = validName(m.Name); msg != "" {
		return msg
	}
	m.Target = strings.TrimSpace(m.Target)
	c := &m.Config
	switch m.Type {
	case "http":
		u, err := url.Parse(m.Target)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "L'URL doit commencer par http:// ou https:// et contenir un hôte"
		}
		if c.Method == "" {
			c.Method = "GET"
		}
		if c.Method != "GET" && c.Method != "HEAD" {
			return "La méthode HTTP doit être GET ou HEAD"
		}
		if c.ExpectedStatus == "" {
			c.ExpectedStatus = "200-399"
		}
		if _, ok := statusMatcher(c.ExpectedStatus); !ok {
			return "Les codes attendus doivent ressembler à « 200-399 » ou « 200,204 »"
		}
		if len(c.Keyword) > 200 {
			return "Le mot-clé doit contenir au plus 200 caractères"
		}
		if c.CheckSSL && u.Scheme != "https" {
			return "La vérification du certificat nécessite une URL https://"
		}
	case "tcp":
		h, p, err := net.SplitHostPort(m.Target)
		if n, perr := strconv.Atoi(p); err != nil || h == "" || perr != nil || n < 1 || n > 65535 {
			return "La cible doit être au format hôte:port (port entre 1 et 65535)"
		}
	case "dns":
		if m.Target == "" || len(m.Target) > 253 || strings.ContainsAny(m.Target, " /:") {
			return "La cible doit être un nom de domaine"
		}
		if c.RecordType == "" {
			c.RecordType = "A"
		}
		switch c.RecordType {
		case "A", "AAAA", "CNAME", "MX", "TXT", "NS":
		default:
			return "Le type d'enregistrement doit être A, AAAA, CNAME, MX, TXT ou NS"
		}
		if c.DNSServer != "" {
			if _, err := dnsServerAddr(c.DNSServer); err != nil {
				return "Le serveur DNS doit être une adresse IP, avec un port facultatif"
			}
		}
	case "ssl":
		host := m.Target
		if h, _, err := net.SplitHostPort(m.Target); err == nil {
			host = h
		}
		if host == "" || strings.ContainsAny(host, " /") {
			return "La cible doit être un nom de domaine, avec un port facultatif"
		}
	default:
		return "Le type de sonde doit être http, tcp, dns ou ssl"
	}
	if m.Type == "ssl" || c.CheckSSL {
		if c.WarnDays == 0 {
			c.WarnDays = 14
		}
		if c.WarnDays < 1 || c.WarnDays > 365 {
			return "Le délai d'alerte doit être compris entre 1 et 365 jours"
		}
	}
	if m.IntervalS == 0 {
		m.IntervalS = 60
	}
	if m.TimeoutS == 0 {
		m.TimeoutS = 10
	}
	if m.IntervalS < 10 || m.IntervalS > 86400 {
		return "L'intervalle doit être compris entre 10 secondes et 24 heures"
	}
	if m.TimeoutS < 1 || m.TimeoutS > 60 || m.TimeoutS >= m.IntervalS {
		return "Le délai d'attente doit être compris entre 1 et 60 secondes et inférieur à l'intervalle"
	}
	if c.DegradedMs < 0 || c.FailureThreshold < 0 || c.FailureThreshold > 10 {
		return "Le seuil d'échecs doit être compris entre 1 et 10"
	}
	return ""
}

// statusMatcher parses "200-399" / "200,204,301-302".
func statusMatcher(spec string) (func(int) bool, bool) {
	type rng struct{ lo, hi int }
	var rs []rng
	for _, part := range strings.Split(spec, ",") {
		lo, hi, isRange := strings.Cut(strings.TrimSpace(part), "-")
		a, err := strconv.Atoi(lo)
		if err != nil {
			return nil, false
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(hi); err != nil {
				return nil, false
			}
		}
		if a < 100 || b > 599 || a > b {
			return nil, false
		}
		rs = append(rs, rng{a, b})
	}
	return func(code int) bool {
		for _, r := range rs {
			if code >= r.lo && code <= r.hi {
				return true
			}
		}
		return false
	}, true
}

func dnsServerAddr(s string) (string, error) {
	if ip := net.ParseIP(s); ip != nil {
		return net.JoinHostPort(s, "53"), nil
	}
	h, p, err := net.SplitHostPort(s)
	if err != nil || net.ParseIP(h) == nil {
		return "", errors.New("invalid")
	}
	if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
		return "", errors.New("invalid")
	}
	return s, nil
}

type checkResult struct {
	status     string
	latency    *float64
	message    string
	certExpiry *time.Time
}

func ms(d time.Duration) *float64 {
	v := float64(d.Microseconds()) / 1000
	return &v
}

func slowOrOK(c *MonitorConfig, lat *float64, okMsg string) checkResult {
	if c.DegradedMs > 0 && *lat > float64(c.DegradedMs) {
		return checkResult{StatusDegraded, lat, fmt.Sprintf("Réponse lente : %.0f ms (seuil %d ms)", *lat, c.DegradedMs), nil}
	}
	return checkResult{StatusOperational, lat, okMsg, nil}
}

func runCheck(ctx context.Context, m *Monitor) checkResult {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(m.TimeoutS)*time.Second)
	defer cancel()
	switch m.Type {
	case "http":
		return checkHTTP(ctx, m)
	case "tcp":
		start := time.Now()
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", m.Target)
		if err != nil {
			return checkResult{StatusMajor, nil, "Connexion impossible : " + err.Error(), nil}
		}
		conn.Close()
		return slowOrOK(&m.Config, ms(time.Since(start)), "Port ouvert")
	case "dns":
		return checkDNS(ctx, m)
	case "ssl":
		return checkSSL(ctx, m)
	}
	return checkResult{StatusUnknown, nil, "Type inconnu", nil}
}

func checkHTTP(ctx context.Context, m *Monitor) checkResult {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: m.Config.IgnoreTLS}
	tr.DisableKeepAlives = true
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("plus de 5 redirections")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, m.Config.Method, m.Target, nil)
	if err != nil {
		return checkResult{StatusMajor, nil, err.Error(), nil}
	}
	req.Header.Set("User-Agent", "hlm-monitor/"+version)
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return checkResult{StatusMajor, nil, "Requête échouée : " + err.Error(), nil}
	}
	defer resp.Body.Close()
	lat := ms(time.Since(start))
	var cert *time.Time
	if m.Config.CheckSSL && resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		na := resp.TLS.PeerCertificates[0].NotAfter
		cert = &na
		// Reachable only with ignore_tls: an expired certificate is still an outage.
		if time.Until(na) <= 0 {
			return checkResult{StatusMajor, lat, "Certificat expiré le " + na.In(localTZ()).Format("02/01/2006"), cert}
		}
	}
	match, _ := statusMatcher(m.Config.ExpectedStatus)
	if !match(resp.StatusCode) {
		return checkResult{StatusMinor, lat, fmt.Sprintf("Code HTTP %d inattendu (attendu %s)", resp.StatusCode, m.Config.ExpectedStatus), cert}
	}
	if m.Config.Keyword != "" {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if !strings.Contains(string(body), m.Config.Keyword) {
			return checkResult{StatusMinor, lat, "Mot-clé absent de la réponse", cert}
		}
	}
	res := slowOrOK(&m.Config, lat, fmt.Sprintf("HTTP %d", resp.StatusCode))
	if cert != nil {
		res.certExpiry = cert
		if res.status == StatusOperational {
			res.message += fmt.Sprintf(" · certificat valide %d jours", daysLeft(*cert))
		}
	}
	return res
}

func checkDNS(ctx context.Context, m *Monitor) checkResult {
	r := net.DefaultResolver
	if m.Config.DNSServer != "" {
		addr, _ := dnsServerAddr(m.Config.DNSServer)
		r = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		}}
	}
	start := time.Now()
	var answers []string
	var err error
	switch m.Config.RecordType {
	case "A", "AAAA":
		nw := map[string]string{"A": "ip4", "AAAA": "ip6"}[m.Config.RecordType]
		var ips []net.IP
		ips, err = r.LookupIP(ctx, nw, m.Target)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	case "CNAME":
		var c string
		c, err = r.LookupCNAME(ctx, m.Target)
		answers = []string{c}
	case "MX":
		var mx []*net.MX
		mx, err = r.LookupMX(ctx, m.Target)
		for _, x := range mx {
			answers = append(answers, x.Host)
		}
	case "TXT":
		answers, err = r.LookupTXT(ctx, m.Target)
	case "NS":
		var ns []*net.NS
		ns, err = r.LookupNS(ctx, m.Target)
		for _, x := range ns {
			answers = append(answers, x.Host)
		}
	}
	lat := ms(time.Since(start))
	if err != nil {
		return checkResult{StatusMajor, nil, "Résolution échouée : " + err.Error(), nil}
	}
	if len(answers) == 0 {
		return checkResult{StatusMinor, lat, "Aucune réponse", nil}
	}
	if exp := m.Config.Expected; exp != "" {
		found := false
		for _, a := range answers {
			if strings.Contains(a, exp) {
				found = true
			}
		}
		if !found {
			return checkResult{StatusMinor, lat, "Réponse inattendue : " + strings.Join(answers, ", "), nil}
		}
	}
	return slowOrOK(&m.Config, lat, strings.Join(answers, ", "))
}

func checkSSL(ctx context.Context, m *Monitor) checkResult {
	addr, host := m.Target, m.Target
	if h, _, err := net.SplitHostPort(m.Target); err == nil {
		host = h
	} else {
		addr = net.JoinHostPort(m.Target, "443")
	}
	start := time.Now()
	d := &tls.Dialer{Config: &tls.Config{ServerName: host}}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return checkResult{StatusMajor, nil, "Certificat invalide ou injoignable : " + err.Error(), nil}
	}
	defer conn.Close()
	lat := ms(time.Since(start))
	certs := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return checkResult{StatusMajor, lat, "Aucun certificat présenté", nil}
	}
	na := certs[0].NotAfter
	expiry := na.In(localTZ()).Format("02/01/2006")
	if time.Until(na) <= 0 {
		return checkResult{StatusMajor, lat, "Certificat expiré le " + expiry, &na}
	}
	// Expiring soon is not an outage: it stays operational and triggers a one-off e-mail warning.
	return checkResult{StatusOperational, lat, fmt.Sprintf("Valide jusqu'au %s (%d jours)", expiry, daysLeft(na)), &na}
}

func daysLeft(t time.Time) int { return int(time.Until(t).Hours() / 24) }

// runMonitors polls for due monitors and checks them with bounded concurrency.
func (s *Server) runMonitors(ctx context.Context) {
	var mu sync.Mutex
	inflight := map[int64]bool{}
	fails := map[int64]int{}
	sem := make(chan struct{}, 16)
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		mons, err := s.loadMonitors(`WHERE enabled=1 AND last_check + interval_s*1000 <= ?`, time.Now().UnixMilli())
		if err != nil {
			slog.Error("load monitors", "err", err)
			continue
		}
		for _, m := range mons {
			mu.Lock()
			busy := inflight[m.ID]
			inflight[m.ID] = true
			mu.Unlock()
			if busy {
				continue
			}
			go func(m Monitor) {
				sem <- struct{}{}
				defer func() { <-sem; mu.Lock(); delete(inflight, m.ID); mu.Unlock() }()
				res := runCheck(ctx, &m)
				if ctx.Err() != nil {
					return
				}
				mu.Lock()
				eff := res.status
				if m.Maintenance {
					eff = StatusMaintenance
				} else if statusRank(res.status) >= statusRank(StatusMinor) {
					// Only flip to an outage after N consecutive failures, to avoid flapping alerts.
					fails[m.ID]++
					if fails[m.ID] < m.Config.threshold() {
						eff = m.Status
					}
				} else {
					fails[m.ID] = 0
				}
				mu.Unlock()
				if err := s.recordResult(&m, res, eff); err != nil {
					slog.Error("record result", "monitor", m.ID, "err", err)
				}
			}(m)
		}
	}
}

func (s *Server) recordResult(m *Monitor, res checkResult, eff string) error {
	now := time.Now()
	stored := res.status
	if m.Maintenance {
		stored = StatusMaintenance
	}
	up := 0
	if statusRank(stored) <= statusRank(StatusDegraded) {
		up = 1
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT OR REPLACE INTO monitor_results(monitor_id,ts,status,latency_ms,message) VALUES(?,?,?,?,?)`,
		m.ID, now.UnixMilli(), stored, res.latency, res.message); err != nil {
		return err
	}
	latSum, latN := 0.0, 0
	if res.latency != nil {
		latSum, latN = *res.latency, 1
	}
	if _, err := tx.Exec(`INSERT INTO monitor_daily(monitor_id,day,total,up,worst,latency_sum,latency_n) VALUES(?,?,1,?,?,?,?)
		ON CONFLICT(monitor_id,day) DO UPDATE SET total=total+1, up=up+excluded.up, worst=MAX(worst,excluded.worst),
		latency_sum=latency_sum+excluded.latency_sum, latency_n=latency_n+excluded.latency_n`,
		m.ID, now.Unix()/86400*86400, up, statusRank(stored), latSum, latN); err != nil {
		return err
	}
	var certUnix *int64
	warnCert := false
	if res.certExpiry != nil {
		u := res.certExpiry.Unix()
		certUnix = &u
		warnCert = daysLeft(*res.certExpiry) < m.Config.WarnDays && u != m.certAlertedFor && !m.Maintenance
	}
	if _, err := tx.Exec(`UPDATE monitors SET status=?, message=?, latency_ms=?, last_check=?, cert_expires_at=COALESCE(?, cert_expires_at),
		cert_alerted_for=CASE WHEN ? THEN ? ELSE cert_alerted_for END WHERE id=?`,
		eff, res.message, res.latency, now.UnixMilli(), certUnix, warnCert, certUnix, m.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if warnCert {
		s.notifier.add(Event{Kind: KindCert, Name: m.Name, Message: fmt.Sprintf("Le certificat expire dans %d jour(s), le %s",
			daysLeft(*res.certExpiry), res.certExpiry.In(localTZ()).Format("02/01/2006 à 15:04")), At: now})
	}
	if eff != m.Status && m.Status != StatusUnknown && eff != StatusUnknown &&
		eff != StatusMaintenance && m.Status != StatusMaintenance {
		s.notifier.add(Event{Kind: "Sonde", Name: m.Name, From: m.Status, To: eff, Message: res.message, At: now})
	}
	return nil
}

const monitorCols = `id,name,type,target,interval_s,timeout_s,config,enabled,maintenance,public,status,message,latency_ms,last_check,cert_expires_at,cert_alerted_for`

func (s *Server) loadMonitors(where string, args ...any) ([]Monitor, error) {
	rows, err := s.db.Query(`SELECT `+monitorCols+` FROM monitors `+where+` ORDER BY name COLLATE NOCASE`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Monitor{}
	for rows.Next() {
		var m Monitor
		var cfg string
		if err := rows.Scan(&m.ID, &m.Name, &m.Type, &m.Target, &m.IntervalS, &m.TimeoutS, &cfg, &m.Enabled, &m.Maintenance, &m.Public, &m.Status, &m.Message, &m.LatencyMs, &m.LastCheck, &m.CertExpires, &m.certAlertedFor); err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(cfg), &m.Config)
		out = append(out, m)
	}
	return out, rows.Err()
}

// attachDays fills the last n days of uptime for each monitor from the daily rollup.
func (s *Server) attachDays(mons []Monitor, n int) error {
	if len(mons) == 0 {
		return nil
	}
	today := time.Now().Unix() / 86400 * 86400
	from := today - int64(n-1)*86400
	rows, err := s.db.Query(`SELECT monitor_id, day, total, up, worst FROM monitor_daily WHERE day>=?`, from)
	if err != nil {
		return err
	}
	defer rows.Close()
	type key struct{ id, day int64 }
	got := map[key]Day{}
	for rows.Next() {
		var id, day, total, up int64
		var worst int
		if err := rows.Scan(&id, &day, &total, &up, &worst); err != nil {
			return err
		}
		u := float64(up) / float64(total)
		got[key{id, day}] = Day{Day: day, Uptime: &u, Worst: rankStatus[min(max(worst, 0), len(rankStatus)-1)]}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range mons {
		mons[i].Days = make([]Day, 0, n)
		for d := from; d <= today; d += 86400 {
			day, ok := got[key{mons[i].ID, d}]
			if !ok {
				day = Day{Day: d, Worst: StatusUnknown}
			}
			mons[i].Days = append(mons[i].Days, day)
		}
	}
	return nil
}

func (s *Server) handleListMonitors(w http.ResponseWriter, r *http.Request) {
	mons, err := s.loadMonitors("")
	if err == nil {
		err = s.attachDays(mons, 90)
	}
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, mons)
}

func (s *Server) getMonitor(w http.ResponseWriter, id int64) (*Monitor, bool) {
	mons, err := s.loadMonitors("WHERE id=?", id)
	if err != nil {
		serverErr(w, err)
		return nil, false
	}
	if len(mons) == 0 {
		writeErr(w, 404, "Sonde introuvable")
		return nil, false
	}
	return &mons[0], true
}

func (s *Server) handleGetMonitor(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	m, ok := s.getMonitor(w, id)
	if !ok {
		return
	}
	mons := []Monitor{*m}
	if err := s.attachDays(mons, 90); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, mons[0])
}

type monitorInput struct {
	Name        string        `json:"name"`
	Type        string        `json:"type"`
	Target      string        `json:"target"`
	IntervalS   int           `json:"interval_s"`
	TimeoutS    int           `json:"timeout_s"`
	Config      MonitorConfig `json:"config"`
	Enabled     *bool         `json:"enabled"`
	Maintenance bool          `json:"maintenance"`
	Public      bool          `json:"public"`
}

func (in monitorInput) toMonitor() (Monitor, string) {
	m := Monitor{Name: in.Name, Type: in.Type, Target: in.Target, IntervalS: in.IntervalS, TimeoutS: in.TimeoutS,
		Config: in.Config, Enabled: in.Enabled == nil || *in.Enabled, Maintenance: in.Maintenance, Public: in.Public}
	return m, m.validate()
}

func (s *Server) insertMonitor(m *Monitor) (int64, error) {
	cfg, _ := json.Marshal(m.Config)
	res, err := s.db.Exec(`INSERT INTO monitors(name,type,target,interval_s,timeout_s,config,enabled,maintenance,public,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		m.Name, m.Type, m.Target, m.IntervalS, m.TimeoutS, string(cfg), m.Enabled, m.Maintenance, m.Public, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Server) handleCreateMonitor(w http.ResponseWriter, r *http.Request) {
	var in monitorInput
	if !readJSON(w, r, &in) {
		return
	}
	m, msg := in.toMonitor()
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	id, err := s.insertMonitor(&m)
	if err != nil {
		serverErr(w, err)
		return
	}
	m.ID, m.Status = id, StatusUnknown
	writeJSON(w, 201, m)
}

func (s *Server) handleUpdateMonitor(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in monitorInput
	if !readJSON(w, r, &in) {
		return
	}
	m, msg := in.toMonitor()
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	cfg, _ := json.Marshal(m.Config)
	// Reset last_check so the new settings are checked right away.
	res, err := s.db.Exec(`UPDATE monitors SET name=?,type=?,target=?,interval_s=?,timeout_s=?,config=?,enabled=?,maintenance=?,public=?,last_check=0 WHERE id=?`,
		m.Name, m.Type, m.Target, m.IntervalS, m.TimeoutS, string(cfg), m.Enabled, m.Maintenance, m.Public, id)
	if err != nil {
		serverErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 404, "Sonde introuvable")
		return
	}
	s.handleGetMonitor(w, r)
}

func (s *Server) handleDeleteMonitor(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Exec(`DELETE FROM monitors WHERE id=?`, id); err != nil {
		serverErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMonitorResults(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	d := rangeParam(r)
	bucket := max(d.Milliseconds()/300, 10_000)
	out, err := s.latencySeries(id, d, bucket)
	if err != nil {
		serverErr(w, err)
		return
	}
	rows, err := s.db.Query(`SELECT ts,status,latency_ms,message FROM monitor_results WHERE monitor_id=? ORDER BY ts DESC LIMIT 50`, id)
	if err != nil {
		serverErr(w, err)
		return
	}
	defer rows.Close()
	type ev struct {
		TS        int64    `json:"ts"`
		Status    string   `json:"status"`
		LatencyMs *float64 `json:"latency_ms"`
		Message   string   `json:"message"`
	}
	recent := []ev{}
	for rows.Next() {
		var e ev
		if err := rows.Scan(&e.TS, &e.Status, &e.LatencyMs, &e.Message); err != nil {
			serverErr(w, err)
			return
		}
		recent = append(recent, e)
	}
	out["recent"] = recent
	writeJSON(w, 200, out)
}

// latencySeries returns bucketed average latency (ms) with timestamps in seconds.
func (s *Server) latencySeries(id int64, d time.Duration, bucketMs int64) (map[string]any, error) {
	rows, err := s.db.Query(`SELECT (ts/?1)*?1 AS t, AVG(latency_ms), MAX(CASE status
			WHEN 'major_outage' THEN 4 WHEN 'minor_outage' THEN 3 WHEN 'degraded' THEN 2 WHEN 'maintenance' THEN 1 ELSE 0 END)
		FROM monitor_results WHERE monitor_id=?2 AND ts>=?3 GROUP BY t ORDER BY t`, bucketMs, id, time.Now().Add(-d).UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ts, lat, worst := []int64{}, []*float64{}, []string{}
	for rows.Next() {
		var t int64
		var l *float64
		var wr int
		if err := rows.Scan(&t, &l, &wr); err != nil {
			return nil, err
		}
		ts, lat, worst = append(ts, t/1000), append(lat, l), append(worst, rankStatus[wr])
	}
	return map[string]any{"t": ts, "latency": lat, "worst": worst}, rows.Err()
}
