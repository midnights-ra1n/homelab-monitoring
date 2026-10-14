// Command hlm-server is the homelab monitoring hub: it receives agent metrics,
// runs probes (HTTP, TCP, DNS, SSL), sends grouped e-mail alerts and serves the web UI.
package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev" // set with -ldflags "-X main.version=..."

type Config struct {
	Listen         string
	DataDir        string
	PublicURL      string
	TrustedProxies []*net.IPNet
}

type Server struct {
	cfg      Config
	db       *sql.DB
	priv     ed25519.PrivateKey
	pub      ed25519.PublicKey
	notifier *Notifier
	limiter  *rateLimiter

	setupMu   sync.Mutex
	setupOpen bool // true until the first account exists

	agentsMu sync.Mutex
	agents   map[int64]*agentConn
}

func main() {
	// Used by the Docker HEALTHCHECK: the distroless image has no curl.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		_, port, _ := net.SplitHostPort(env("HLM_LISTEN", ":8080"))
		c := &http.Client{Timeout: 3 * time.Second}
		resp, err := c.Get("http://127.0.0.1:" + port + "/api/health")
		if err != nil || resp.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	cfg := Config{
		Listen:    env("HLM_LISTEN", ":8080"),
		DataDir:   env("HLM_DATA_DIR", "./data"),
		PublicURL: strings.TrimRight(os.Getenv("HLM_PUBLIC_URL"), "/"),
	}
	for _, c := range strings.Split(os.Getenv("HLM_TRUSTED_PROXIES"), ",") {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			slog.Error("invalid HLM_TRUSTED_PROXIES entry", "value", c)
			os.Exit(1)
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, n)
	}
	if err := run(cfg); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func run(cfg Config) error {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	db, err := openDB(cfg.DataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	priv, err := loadOrCreateKey(cfg.DataDir)
	if err != nil {
		return err
	}
	s := &Server{
		cfg: cfg, db: db, priv: priv, pub: priv.Public().(ed25519.PublicKey),
		limiter: newRateLimiter(10, time.Minute),
		agents:  map[int64]*agentConn{},
	}
	s.notifier = newNotifier(s)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := s.initDevMode(ctx); err != nil {
		return err
	}
	if err := s.initSetup(); err != nil {
		return err
	}
	go s.runMonitors(ctx)
	go s.watchHosts(ctx)
	go s.runRetention(ctx)
	go s.runReports(ctx)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()
	slog.Info("hlm-server listening", "addr", cfg.Listen, "version", version)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	s.notifier.flush()
	return nil
}
