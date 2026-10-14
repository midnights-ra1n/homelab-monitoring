package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Wire format shared with rust-agent/src/main.rs. Keep both in sync.
type agentInfo struct {
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Kernel       string `json:"kernel"`
	Arch         string `json:"arch"`
	CPUModel     string `json:"cpu_model"`
	CPUCores     int    `json:"cpu_cores"`
	MemTotal     uint64 `json:"mem_total"`
	AgentVersion string `json:"agent_version"`
	BootTime     int64  `json:"boot_time"`
}

type agentDisk struct {
	Mount string `json:"mount"`
	FS    string `json:"fs"`
	Used  uint64 `json:"used"`
	Total uint64 `json:"total"`
}

type agentTemp struct {
	Label   string  `json:"label"`
	Celsius float64 `json:"c"`
}

type agentIface struct {
	Name string  `json:"name"`
	Rx   float64 `json:"rx"`
	Tx   float64 `json:"tx"`
}

type agentMetrics struct {
	CPU       float64      `json:"cpu"`
	MemUsed   uint64       `json:"mem_used"`
	MemTotal  uint64       `json:"mem_total"`
	SwapUsed  uint64       `json:"swap_used"`
	SwapTotal uint64       `json:"swap_total"`
	DiskUsed  uint64       `json:"disk_used"`
	DiskTotal uint64       `json:"disk_total"`
	NetRx     float64      `json:"net_rx"`
	NetTx     float64      `json:"net_tx"`
	Load1     float64      `json:"load1"`
	Temp      *float64     `json:"temp"`
	CPUTemp   *float64     `json:"cpu_temp"`
	Disks     []agentDisk  `json:"disks"`
	Temps     []agentTemp  `json:"temps"`
	Ifaces    []agentIface `json:"ifaces"`
}

type agentPackage struct {
	Name      string `json:"name"`
	Current   string `json:"current"`
	Candidate string `json:"candidate"`
	Security  bool   `json:"security"`
}

type agentUpdates struct {
	Manager        string         `json:"manager"`
	Packages       []agentPackage `json:"packages,omitempty"`
	RebootRequired bool           `json:"reboot_required"`
	ListsUpdatedAt int64          `json:"lists_updated_at"` // last apt-get update, unix seconds
	CheckedAt      int64          `json:"checked_at"`
	// Computed by the hub, so list views can drop Packages and keep the counts.
	Pending  int `json:"pending"`
	Security int `json:"security"`
	// What was already e-mailed, so each update or reboot is reported once.
	AlertedSecurity []string `json:"alerted_security,omitempty"`
	RebootAlerted   bool     `json:"reboot_alerted,omitempty"`
}

type agentMsg struct {
	Type    string          `json:"type"`
	Info    *agentInfo      `json:"info,omitempty"`
	Metrics *agentMetrics   `json:"metrics,omitempty"`
	Updates *agentUpdates   `json:"updates,omitempty"`
	Smart   *smartReport    `json:"smart,omitempty"`
	Docker  *dockerSnapshot `json:"docker,omitempty"`
	// action_result fields
	Action  string `json:"action,omitempty"`
	State   string `json:"state,omitempty"`
	Message string `json:"message,omitempty"`
}

type agentConn struct {
	conn *websocket.Conn
	ctx  context.Context // the agent connection's context, for writes from other requests
}

type Host struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Status      string          `json:"status"`
	LastSeen    int64           `json:"last_seen"`
	Maintenance bool            `json:"maintenance"`
	Public      bool            `json:"public"`
	Connected   bool            `json:"connected"`
	Info        json.RawMessage `json:"info"`
	Latest      json.RawMessage `json:"latest"`
	Updates     *agentUpdates   `json:"updates"`
	Action      *hostAction     `json:"action"`         // last dashboard action (updates, agent update)
	Docker      *dockerSnapshot `json:"docker"`         // nil when the host has no Docker
	AgentLatest string          `json:"agent_latest"`   // latest published agent release, "" if unknown
	Outdated    bool            `json:"agent_outdated"` // agent older than AgentLatest
	CreatedAt   int64           `json:"created_at"`
}

type hostAction struct {
	Action  string `json:"action"`           // check_updates, apply_updates, update_agent, update_container
	Target  string `json:"target,omitempty"` // container name for update_container
	State   string `json:"state"`            // pending, running, done, failed
	Message string `json:"message"`
	At      int64  `json:"at"`
}

// withoutPackages keeps update counts but drops package lists, for list views polled often.
func withoutPackages(hosts []Host) []Host {
	for i := range hosts {
		if hosts[i].Updates != nil {
			u := *hosts[i].Updates
			u.Packages, u.AlertedSecurity = nil, nil
			hosts[i].Updates = &u
		}
	}
	return hosts
}

const agentAuthContext = "hlm-agent-auth-v1:"

func (s *Server) agentInterval() int {
	n, err := strconv.Atoi(s.getSetting("agent_interval_s", "30"))
	if err != nil || n < 5 {
		return 30
	}
	return n
}

func (s *Server) hostStatus(h *Host) string {
	if h.Maintenance {
		return StatusMaintenance
	}
	if h.LastSeen == 0 {
		return StatusUnknown
	}
	if time.Since(time.Unix(h.LastSeen, 0)) > time.Duration(3*s.agentInterval()+15)*time.Second {
		return StatusMajor
	}
	var m agentMetrics
	if json.Unmarshal(h.Latest, &m) == nil {
		for _, d := range m.Disks {
			if d.Total > 0 && float64(d.Used)/float64(d.Total) >= 0.95 {
				return StatusDegraded
			}
		}
		if m.MemTotal > 0 && float64(m.MemUsed)/float64(m.MemTotal) >= 0.95 {
			return StatusDegraded
		}
	}
	return StatusOperational
}

func (s *Server) loadHosts(where string, args ...any) ([]Host, error) {
	rows, err := s.db.Query(`SELECT id,name,last_seen,maintenance,public,info,latest,updates,action,docker,created_at FROM hosts `+where+` ORDER BY name COLLATE NOCASE`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hosts := []Host{}
	for rows.Next() {
		var h Host
		var info, latest, updates, action, docker string
		if err := rows.Scan(&h.ID, &h.Name, &h.LastSeen, &h.Maintenance, &h.Public, &info, &latest, &updates, &action, &docker, &h.CreatedAt); err != nil {
			return nil, err
		}
		h.Info, h.Latest = json.RawMessage(info), json.RawMessage(latest)
		var u agentUpdates
		if json.Unmarshal([]byte(updates), &u) == nil && u.CheckedAt > 0 {
			h.Updates = &u
		}
		var a hostAction
		if json.Unmarshal([]byte(action), &a) == nil && a.Action != "" {
			h.Action = &a
		}
		var d dockerSnapshot
		if json.Unmarshal([]byte(docker), &d) == nil && d.CollectedAt > 0 {
			h.Docker = &d
		}
		var ai agentInfo
		json.Unmarshal(h.Info, &ai)
		h.AgentLatest = latestAgentVersion()
		h.Outdated = versionLess(ai.AgentVersion, h.AgentLatest)
		hosts = append(hosts, h)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.agentsMu.Lock()
	for i := range hosts {
		_, hosts[i].Connected = s.agents[hosts[i].ID]
		hosts[i].Status = s.hostStatus(&hosts[i])
	}
	s.agentsMu.Unlock()
	return hosts, nil
}

func (s *Server) handleListHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.loadHosts("")
	if err != nil {
		serverErr(w, err)
		return
	}
	if r.URL.Query().Get("packages") != "1" {
		hosts = withoutPackages(hosts)
	}
	writeJSON(w, 200, hosts)
}

func (s *Server) handleGetHost(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
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
	writeJSON(w, 200, hosts[0])
}

func validName(n string) (string, string) {
	n = strings.TrimSpace(n)
	if n == "" || len(n) > 100 {
		return "", "Le nom doit contenir entre 1 et 100 caractères"
	}
	return n, ""
}

// agentHubURL is the address agents use: the setting chosen in the UI, else HLM_PUBLIC_URL,
// else the address the browser used.
func (s *Server) agentHubURL(r *http.Request) string {
	if u := strings.TrimRight(strings.TrimSpace(s.getSetting("agent_hub_url", "")), "/"); u != "" {
		return u
	}
	return s.baseURL(r)
}

func (s *Server) installInfo(r *http.Request, token string) map[string]string {
	hub := s.agentHubURL(r)
	key := base64.StdEncoding.EncodeToString(s.pub)
	insecure := ""
	if strings.HasPrefix(hub, "http://") {
		insecure = "ALLOW_INSECURE=true "
	}
	return map[string]string{
		"hub_url": hub,
		"key":     key,
		"token":   token,
		"command": "curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/install.sh | sudo HUB_URL='" + hub + "' TOKEN='" + token + "' KEY='" + key + "' " + insecure + "sh",
	}
}

func (s *Server) handleCreateHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, msg := validName(req.Name)
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	tok := randomToken(32)
	res, err := s.db.Exec(`INSERT INTO hosts(name,token_hash,created_at) VALUES(?,?,?)`, name, hashToken(tok), time.Now().Unix())
	if err != nil {
		serverErr(w, err)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, 201, map[string]any{"id": id, "install": s.installInfo(r, tok)})
}

func (s *Server) handleRotateHostToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tok := randomToken(32)
	res, err := s.db.Exec(`UPDATE hosts SET token_hash=? WHERE id=?`, hashToken(tok), id)
	if err != nil {
		serverErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 404, "Hôte introuvable")
		return
	}
	s.dropAgent(id)
	writeJSON(w, 200, map[string]any{"install": s.installInfo(r, tok)})
}

func (s *Server) handleUpdateHost(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Maintenance *bool   `json:"maintenance"`
		Public      *bool   `json:"public"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Name != nil {
		n, msg := validName(*req.Name)
		if msg != "" {
			writeErr(w, 400, msg)
			return
		}
		req.Name = &n
	}
	_, err := s.db.Exec(`UPDATE hosts SET name=COALESCE(?,name), maintenance=COALESCE(?,maintenance), public=COALESCE(?,public) WHERE id=?`,
		req.Name, req.Maintenance, req.Public, id)
	if err != nil {
		serverErr(w, err)
		return
	}
	s.handleGetHost(w, r)
}

func (s *Server) handleDeleteHost(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Exec(`DELETE FROM hosts WHERE id=?`, id); err != nil {
		serverErr(w, err)
		return
	}
	s.dropAgent(id)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dropAgent(id int64) {
	s.agentsMu.Lock()
	if a := s.agents[id]; a != nil {
		a.conn.Close(websocket.StatusPolicyViolation, "credentials revoked")
		delete(s.agents, id)
	}
	s.agentsMu.Unlock()
}

// handleHostMetrics returns ~300 averaged points for the requested range, so charts
// stay light whatever the retention.
func (s *Server) handleHostMetrics(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	d := rangeParam(r)
	bucket := max(int64(d.Seconds())/300, int64(s.agentInterval()))
	rows, err := s.db.Query(`SELECT (ts/?1)*?1 AS t, AVG(cpu),
		AVG(CASE WHEN mem_total>0 THEN mem_used*100.0/mem_total END),
		AVG(CASE WHEN swap_total>0 THEN swap_used*100.0/swap_total END),
		AVG(CASE WHEN disk_total>0 THEN disk_used*100.0/disk_total END),
		AVG(net_rx), AVG(net_tx), AVG(load1), MAX(temp), MAX(cpu_temp)
		FROM host_metrics WHERE host_id=?2 AND ts>=?3 GROUP BY t ORDER BY t`,
		bucket, id, time.Now().Add(-d).Unix())
	if err != nil {
		serverErr(w, err)
		return
	}
	defer rows.Close()
	type point struct {
		T                                              int64
		CPU, Mem, Swap, Disk, Rx, Tx, L, Temp, CPUTemp *float64
	}
	out := map[string][]any{"t": {}, "cpu": {}, "mem": {}, "swap": {}, "disk": {}, "net_rx": {}, "net_tx": {}, "load1": {}, "temp": {}, "cpu_temp": {}}
	for rows.Next() {
		var p point
		if err := rows.Scan(&p.T, &p.CPU, &p.Mem, &p.Swap, &p.Disk, &p.Rx, &p.Tx, &p.L, &p.Temp, &p.CPUTemp); err != nil {
			serverErr(w, err)
			return
		}
		out["t"] = append(out["t"], p.T)
		out["cpu"] = append(out["cpu"], p.CPU)
		out["mem"] = append(out["mem"], p.Mem)
		out["swap"] = append(out["swap"], p.Swap)
		out["disk"] = append(out["disk"], p.Disk)
		out["net_rx"] = append(out["net_rx"], p.Rx)
		out["net_tx"] = append(out["net_tx"], p.Tx)
		out["load1"] = append(out["load1"], p.L)
		out["temp"] = append(out["temp"], p.Temp)
		out["cpu_temp"] = append(out["cpu_temp"], p.CPUTemp)
	}
	if err := rows.Err(); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, out)
}

// handleAgentWS authenticates an agent in both directions, Beszel-style:
// the agent proves itself with its token, the hub proves itself by signing the
// agent's nonce with the key the agent was installed with.
func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	tok, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	nonce, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Agent-Nonce"))
	if !found || len(tok) < 32 || err != nil || len(nonce) != 32 {
		writeErr(w, 400, "Poignée de main agent invalide")
		return
	}
	th := hashToken(tok)
	var id int64
	var hostName, issued string
	if err := s.db.QueryRow(`SELECT id, name FROM hosts WHERE token_hash=?`, th).Scan(&id, &hostName); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			serverErr(w, err)
			return
		}
		if !s.limiter.allow("agent:" + ip) {
			writeErr(w, http.StatusTooManyRequests, "Trop de tentatives")
			return
		}
		var ok bool
		if strings.HasPrefix(tok, enrollPrefix) {
			id, hostName, issued, ok, err = s.enrollHost(tok, r.Header.Get("X-Agent-Hostname"))
			if err != nil {
				serverErr(w, err)
				return
			}
		}
		if !ok {
			slog.Warn("agent rejected: unknown token", "ip", ip)
			writeErr(w, http.StatusUnauthorized, "Jeton agent inconnu")
			return
		}
		slog.Info("agent enrolled", "host_id", id, "name", hostName, "ip", ip)
	}
	// The HTTP server's read timeout must not apply to this long-lived connection.
	http.NewResponseController(w).SetReadDeadline(time.Time{})
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(1 << 20)
	defer c.CloseNow()

	s.agentsMu.Lock()
	if old := s.agents[id]; old != nil {
		old.conn.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
	}
	me := &agentConn{conn: c, ctx: r.Context()}
	s.agents[id] = me
	s.agentsMu.Unlock()
	defer func() {
		s.agentsMu.Lock()
		if s.agents[id] == me {
			delete(s.agents, id)
		}
		s.agentsMu.Unlock()
	}()

	ctx := r.Context()
	interval := s.agentInterval()
	msg := append([]byte(agentAuthContext), nonce...)
	msg = append(msg, th...)
	hello := map[string]any{"type": "hello", "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, msg)), "interval": interval}
	if issued != "" {
		hello["token"] = issued // personal token for an enrolled agent, to use instead of the shared one
	}
	if err := wsjson.Write(ctx, c, hello); err != nil {
		return
	}
	slog.Info("agent connected", "host_id", id, "ip", ip)

	var lastMetrics time.Time
	for {
		rctx, cancel := context.WithTimeout(ctx, time.Duration(3*interval+30)*time.Second)
		var m agentMsg
		err := wsjson.Read(rctx, c, &m)
		cancel()
		if err != nil {
			slog.Info("agent disconnected", "host_id", id, "err", err)
			return
		}
		switch {
		case m.Type == "info" && m.Info != nil:
			b, _ := json.Marshal(m.Info)
			if _, err := s.db.Exec(`UPDATE hosts SET info=? WHERE id=?`, string(b), id); err != nil {
				slog.Error("store agent info", "err", err)
			}
		case m.Type == "action_result" && hostActions[m.Action] && (m.State == "running" || m.State == "done" || m.State == "failed"):
			s.setHostAction(id, m.Action, m.State, m.Message)
		case m.Type == "docker" && m.Docker != nil:
			if err := s.storeDocker(id, hostName, m.Docker); err != nil {
				slog.Error("store docker", "err", err)
			}
		case m.Type == "smart" && m.Smart != nil:
			if err := s.storeSmart(id, hostName, m.Smart); err != nil {
				slog.Error("store smart", "err", err)
			}
		case m.Type == "updates" && m.Updates != nil:
			if err := s.storeUpdates(id, hostName, m.Updates); err != nil {
				slog.Error("store updates", "err", err)
			}
		case m.Type == "metrics" && m.Metrics != nil:
			// Ignore an agent pushing faster than asked instead of letting it fill the disk.
			if time.Since(lastMetrics) < time.Duration(interval)*time.Second/2 {
				continue
			}
			lastMetrics = time.Now()
			if err := s.storeMetrics(id, m.Metrics); err != nil {
				slog.Error("store metrics", "err", err)
			}
		}
	}
}

func (s *Server) storeUpdates(id int64, hostName string, u *agentUpdates) error {
	if len(u.Packages) > 5000 {
		u.Packages = u.Packages[:5000]
	}
	u.Pending, u.Security = len(u.Packages), 0
	var security []string
	for _, p := range u.Packages {
		if p.Security {
			u.Security++
			security = append(security, p.Name+" "+p.Candidate)
		}
	}
	u.CheckedAt = time.Now().Unix()

	// Alert once per new security update and once per reboot request, never on every scan.
	var prev agentUpdates
	var raw string
	if s.db.QueryRow(`SELECT updates FROM hosts WHERE id=?`, id).Scan(&raw) == nil {
		json.Unmarshal([]byte(raw), &prev)
	}
	known := map[string]bool{}
	for _, k := range prev.AlertedSecurity {
		known[k] = true
	}
	var fresh []string
	for _, k := range security {
		if !known[k] {
			fresh = append(fresh, strings.SplitN(k, " ", 2)[0])
		}
	}
	u.AlertedSecurity, u.RebootAlerted = security, u.RebootRequired
	if len(fresh) > 0 && s.getSetting("notify_security_updates", "true") == "true" {
		list := strings.Join(fresh[:min(len(fresh), 8)], ", ")
		if len(fresh) > 8 {
			list += fmt.Sprintf(" et %d autre(s)", len(fresh)-8)
		}
		s.notifier.add(Event{Kind: KindUpdates, Name: hostName, Message: fmt.Sprintf("%d nouvelle(s) mise(s) à jour de sécurité : %s", len(fresh), list), At: time.Now()})
	}
	if u.RebootRequired && !prev.RebootAlerted && s.getSetting("notify_reboot", "true") == "true" {
		s.notifier.add(Event{Kind: KindReboot, Name: hostName, Message: "Un redémarrage est nécessaire pour appliquer les mises à jour installées", At: time.Now()})
	}
	b, _ := json.Marshal(u)
	_, err := s.db.Exec(`UPDATE hosts SET updates=? WHERE id=?`, string(b), id)
	return err
}

func (s *Server) storeMetrics(id int64, m *agentMetrics) error {
	trim := func(n int) {
		if len(m.Disks) > n {
			m.Disks = m.Disks[:n]
		}
		if len(m.Temps) > n {
			m.Temps = m.Temps[:n]
		}
		if len(m.Ifaces) > n {
			m.Ifaces = m.Ifaces[:n]
		}
	}
	trim(64)
	latest, _ := json.Marshal(m)
	now := time.Now().Unix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT OR REPLACE INTO host_metrics(host_id,ts,cpu,mem_used,mem_total,swap_used,swap_total,disk_used,disk_total,net_rx,net_tx,load1,temp,cpu_temp)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, now, m.CPU, m.MemUsed, m.MemTotal, m.SwapUsed, m.SwapTotal, m.DiskUsed, m.DiskTotal, m.NetRx, m.NetTx, m.Load1, m.Temp, m.CPUTemp); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE hosts SET latest=?, last_seen=? WHERE id=?`, string(latest), now, id); err != nil {
		return err
	}
	var memPct float64
	if m.MemTotal > 0 {
		memPct = float64(m.MemUsed) * 100 / float64(m.MemTotal)
	}
	// Daily rollup for monthly reports, kept longer than raw metrics.
	if _, err := tx.Exec(`INSERT INTO host_daily(host_id,day,samples,cpu_sum,mem_sum) VALUES(?,?,1,?,?)
		ON CONFLICT(host_id,day) DO UPDATE SET samples=samples+1, cpu_sum=cpu_sum+excluded.cpu_sum, mem_sum=mem_sum+excluded.mem_sum`,
		id, now/86400*86400, m.CPU, memPct); err != nil {
		return err
	}
	return tx.Commit()
}

// watchHosts turns host status changes into notifications.
func (s *Server) watchHosts(ctx context.Context) {
	prev := map[int64]string{}
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		hosts, err := s.loadHosts("")
		if err == nil {
			for _, h := range hosts {
				if p, seen := prev[h.ID]; seen && p != h.Status && p != StatusUnknown && h.Status != StatusUnknown {
					s.notifier.add(Event{Kind: "Hôte", Name: h.Name, From: p, To: h.Status, At: time.Now()})
				}
				prev[h.ID] = h.Status
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
