//go:build devmode

// Test mode, compiled only with `go build -tags devmode` (never by the Dockerfile or CI):
// creates a known admin account and demo hosts/monitors fed with simulated metrics,
// so the UI can be developed without real agents.
package main

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"time"
)

const devMode = true

const (
	devUser     = "admin"
	devPassword = "devmode-password"
)

func (s *Server) initDevMode(ctx context.Context) error {
	// Second lock: a release binary carries a version, and a devmode binary refuses to run with one.
	if version != "dev" {
		return errors.New("devmode build refused: test mode cannot run in a release build")
	}
	slog.Warn("TEST MODE: demo data and a known admin password, never expose this instance", "user", devUser, "password", devPassword)

	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)`, devUser, hashPassword(devPassword), time.Now().Unix()); err != nil {
			return err
		}
	}

	if err := s.db.QueryRow(`SELECT COUNT(*) FROM hosts`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		for _, name := range []string{"demo-pve-01", "demo-nas", "demo-docker"} {
			if _, err := s.db.Exec(`INSERT INTO hosts(name,token_hash,created_at) VALUES(?,?,?)`, name, hashToken(randomToken(32)), time.Now().Unix()); err != nil {
				return err
			}
		}
		_, port, _ := net.SplitHostPort(s.cfg.Listen)
		self := "127.0.0.1:" + port
		for _, m := range []Monitor{
			{Name: "Hub (HTTP)", Type: "http", Target: "http://" + self + "/api/health"},
			{Name: "Hub (TCP)", Type: "tcp", Target: self},
			{Name: "Port fermé", Type: "tcp", Target: "127.0.0.1:1"},
		} {
			m.Enabled = true
			if msg := m.validate(); msg != "" {
				return errors.New(msg)
			}
			if _, err := s.insertMonitor(&m); err != nil {
				return err
			}
		}
	}
	go s.simulateAgents(ctx)
	return nil
}

// simulateAgents stores plausible metrics for every demo-* host at the agent interval.
func (s *Server) simulateAgents(ctx context.Context) {
	for {
		hosts, err := s.loadHosts(`WHERE name LIKE 'demo-%'`)
		if err == nil {
			t := float64(time.Now().Unix())
			for i, h := range hosts {
				phase := float64(i) * 1.7
				wave := (math.Sin(t/600+phase) + 1) / 2 // slow 1-hour cycle
				const gb = 1 << 30
				memTotal := uint64(16 * gb)
				temp := 40 + 25*wave
				m := &agentMetrics{
					CPU: 10 + 70*wave + rand.Float64()*5, MemUsed: uint64(float64(memTotal) * (0.4 + 0.3*wave)), MemTotal: memTotal,
					SwapUsed: gb / 2, SwapTotal: 2 * gb, DiskUsed: uint64(400+i*150) * gb, DiskTotal: 1000 * gb,
					NetRx: 2e6 * wave * (1 + rand.Float64()), NetTx: 5e5 * wave * (1 + rand.Float64()), Load1: 4 * wave, Temp: &temp,
					Disks:  []agentDisk{{Mount: "/", FS: "ext4", Used: uint64(400+i*150) * gb, Total: 1000 * gb}},
					Temps:  []agentTemp{{Label: "Package id 0", Celsius: temp}},
					Ifaces: []agentIface{{Name: "eth0", Rx: 2e6 * wave, Tx: 5e5 * wave}},
				}
				s.db.Exec(`UPDATE hosts SET info=? WHERE id=? AND info='{}'`, `{"hostname":"`+h.Name+`","os":"Debian GNU/Linux 13 (trixie)","kernel":"6.12.0","arch":"x86_64","cpu_model":"Simulated CPU","cpu_cores":8,"mem_total":17179869184,"agent_version":"devmode"}`, h.ID)
				if err := s.storeMetrics(h.ID, m); err != nil {
					slog.Error("devmode metrics", "err", err)
				}
				var smartRaw string
				s.db.QueryRow(`SELECT smart FROM hosts WHERE id=?`, h.ID).Scan(&smartRaw)
				if smartRaw == "{}" {
					yes := true
					fp := func(x float64) *float64 { return &x }
					disks := []smartDisk{
						{Name: "/dev/nvme0", Model: "Samsung SSD 980 PRO 1TB", Serial: "S1" + h.Name, Kind: "nvme", CapacityBytes: 1e12, SmartPassed: &yes,
							TemperatureC: fp(41), PowerOnHours: fp(9000), WearUsedPct: fp(float64(4 + i*30)), SparePct: fp(100), SpareThreshPct: fp(10), MediaErrors: fp(0), CriticalWarn: fp(0)},
						{Name: "/dev/sda", Model: "WDC WD40EFRX-68N32N0", Serial: "WD" + h.Name, Kind: "hdd", CapacityBytes: 4e12, SmartPassed: &yes,
							TemperatureC: fp(36), PowerOnHours: fp(float64(12000 + i*15000)), Reallocated: fp(float64(i * i * 6)), Pending: fp(float64(i / 2 * 3)), CRCErrors: fp(0)},
					}
					s.storeSmart(h.ID, h.Name, &smartReport{Disks: disks})
				}
				if h.Name == "demo-docker" {
					fp := func(x float64) *float64 { return &x }
					const mb = 1 << 20
					s.storeDocker(h.ID, &dockerSnapshot{Containers: []dockerContainer{
						{ID: "a1b2c3d4e5f6", Name: "nextcloud-app-1", Image: "nextcloud:29-apache", State: "running", Health: "healthy", CPUPct: fp(3 + 10*wave), MemUsed: fp(420 * mb), MemLimit: fp(8192 * mb), NetRx: fp(9e8), NetTx: fp(3e8), ComposeProject: "nextcloud", ComposeService: "app", Update: "available"},
						{ID: "b2c3d4e5f6a1", Name: "nextcloud-db-1", Image: "mariadb:11", State: "running", Health: "healthy", CPUPct: fp(1.2), MemUsed: fp(180 * mb), MemLimit: fp(8192 * mb), NetRx: fp(2e8), NetTx: fp(4e8), ComposeProject: "nextcloud", ComposeService: "db", Update: "up_to_date"},
						{ID: "c3d4e5f6a1b2", Name: "uptime-kuma", Image: "louislam/uptime-kuma:1", State: "running", CPUPct: fp(0.4), MemUsed: fp(95 * mb), MemLimit: fp(8192 * mb), NetRx: fp(5e7), NetTx: fp(6e7), Update: "available"},
						{ID: "d4e5f6a1b2c3", Name: "backup-job", Image: "restic/restic:0.17", State: "exited", ComposeProject: "backup", ComposeService: "restic", Update: "unknown"},
						{ID: "e5f6a1b2c3d4", Name: "homepage", Image: "local/homepage:dev", State: "running", CPUPct: fp(0.1), MemUsed: fp(40 * mb), MemLimit: fp(512 * mb), Update: "local"},
					}})
				}
				if h.Updates == nil {
					pk := []agentPackage{
						{Name: "libssl3", Current: "3.0.11-1~deb12u1", Candidate: "3.0.11-1~deb12u2", Security: true},
						{Name: "openssh-server", Current: "1:9.2p1-2+deb12u2", Candidate: "1:9.2p1-2+deb12u3", Security: true},
						{Name: "tzdata", Current: "2024a-0+deb12u1", Candidate: "2024b-0+deb12u1"},
						{Name: "curl", Current: "7.88.1-10+deb12u7", Candidate: "7.88.1-10+deb12u8"},
					}
					s.storeUpdates(h.ID, &agentUpdates{Manager: "apt", Packages: pk[:i*2], RebootRequired: i == 2, ListsUpdatedAt: time.Now().Add(-3 * time.Hour).Unix()})
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(s.agentInterval()) * time.Second):
		}
	}
}
