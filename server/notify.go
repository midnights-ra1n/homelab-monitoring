package main

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	textTemplate "text/template"
	"time"
)

// KindCert events warn about a certificate nearing expiry; they carry no status change.
const KindCert = "Certificat SSL"

// KindDisk events report a disk whose SMART health became "replace" or "failing".
const KindDisk = "Disque"

type Event struct {
	Kind    string // "Hôte", "Sonde" or KindCert
	Name    string
	From    string
	To      string
	Message string
	At      time.Time
}

// Notifier groups every status change that happens within the grouping window into a
// single e-mail, so 15 services going down at once produce one message, not 15.
type Notifier struct {
	s       *Server
	mu      sync.Mutex
	pending []Event
	timer   *time.Timer
}

func newNotifier(s *Server) *Notifier { return &Notifier{s: s} }

func (n *Notifier) add(e Event) {
	slog.Info("status change", "kind", e.Kind, "name", e.Name, "from", e.From, "to", e.To)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.pending = append(n.pending, e)
	if n.timer == nil {
		win, err := strconv.Atoi(n.s.getSetting("notify_window_s", "60"))
		if err != nil || win < 0 {
			win = 60
		}
		n.timer = time.AfterFunc(time.Duration(win)*time.Second, n.flush)
	}
}

func (n *Notifier) flush() {
	n.mu.Lock()
	evs := n.pending
	n.pending, n.timer = nil, nil
	n.mu.Unlock()
	if len(evs) == 0 || n.s.getSetting("smtp_enabled", "false") != "true" {
		return
	}
	if err := n.s.sendAlert(evs); err != nil {
		slog.Error("send alert e-mail", "err", err, "events", len(evs))
	}
}

var statusLabels = map[string]string{
	StatusOperational: "Opérationnel",
	StatusDegraded:    "Performances dégradées",
	StatusMaintenance: "Maintenance",
	StatusMinor:       "Panne partielle",
	StatusMajor:       "Panne majeure",
	StatusUnknown:     "Inconnu",
}

// statusColors are the Midnights Classic "-solid" status tokens, inlined because e-mail clients ignore CSS variables.
var statusColors = map[string]string{
	StatusOperational: "#008a39", StatusDegraded: "#a65f00", StatusMaintenance: "#0074ca",
	StatusMinor: "#bd413f", StatusMajor: "#9d3533", StatusUnknown: "#717c83",
}

const defaultSubject = `{{if .Down}}[Alerte] {{.Down}} service(s) en panne{{else if .Warnings}}[Avertissement] {{.Warnings}} avertissement(s) : certificat ou disque{{else}}[Rétabli] {{len .Events}} changement(s) d'état{{end}}`

const defaultEmailHTML = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f2f6f8;font-family:Geist,system-ui,-apple-system,'Segoe UI',sans-serif;color:#131b1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d8dfe3;border-radius:6px">
<tr><td style="padding:16px;border-bottom:1px solid #e7ecef">
<div style="font-size:18px;font-weight:600">{{.Title}}</div>
<div style="font-size:13px;color:#546066">{{len .Events}} changement(s) d'état · {{.Date}}</div>
</td></tr>
{{range .Events}}<tr><td style="padding:12px 16px;border-bottom:1px solid #e7ecef;font-size:14px">
<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;color:#ffffff;background:{{.Color}}">{{.ToLabel}}</span>
<strong style="font-weight:600;margin-left:6px">{{.Name}}</strong> <span style="color:#546066">({{.Kind}})</span>
<div style="font-size:13px;color:#546066;margin-top:4px">{{if .FromLabel}}{{.FromLabel}} → {{.ToLabel}} à {{.Time}}{{else}}{{.Time}}{{end}}{{if .Message}} · {{.Message}}{{end}}</div>
</td></tr>{{end}}
<tr><td style="padding:12px 16px;font-size:12px;color:#67727a">{{if .URL}}<a href="{{.URL}}" style="color:#16695a">Ouvrir le tableau de bord</a>{{end}}</td></tr>
</table></td></tr></table></body></html>`

type emailEvent struct {
	Event
	FromLabel, ToLabel, Color, Time string
}

type emailData struct {
	Title    string
	Date     string
	URL      string
	Down     int
	Warnings int // certificates nearing expiry
	Events   []emailEvent
}

func (s *Server) emailData(evs []Event) emailData {
	return buildEmailData(s.getSetting("status_title", "Homelab"), s.cfg.PublicURL, evs)
}

func buildEmailData(title, url string, evs []Event) emailData {
	d := emailData{Title: title, Date: time.Now().Format("02/01/2006 15:04"), URL: url}
	for _, e := range evs {
		ee := emailEvent{Event: e, FromLabel: statusLabels[e.From], ToLabel: statusLabels[e.To], Color: statusColors[e.To], Time: e.At.Format("15:04:05")}
		if e.Kind == KindCert {
			d.Warnings++
			ee.FromLabel, ee.ToLabel, ee.Color = "", "Expiration proche", statusColors[StatusDegraded]
		} else if e.Kind == KindDisk {
			d.Warnings++
			ee.FromLabel, ee.ToLabel, ee.Color = "", "Disque à remplacer", statusColors[StatusMinor]
		} else if statusRank(e.To) >= statusRank(StatusMinor) {
			d.Down++
		}
		d.Events = append(d.Events, ee)
	}
	return d
}

// sampleEvents feeds template validation and the test e-mail.
func sampleEvents() []Event {
	now := time.Now()
	return []Event{
		{Kind: "Sonde", Name: "nextcloud", From: StatusOperational, To: StatusMajor, Message: "Requête échouée : délai dépassé", At: now},
		{Kind: "Hôte", Name: "pve-01", From: StatusOperational, To: StatusDegraded, At: now},
		{Kind: KindCert, Name: "cloud.example.fr", Message: "Le certificat expire dans 3 jour(s)", At: now},
	}
}

// renderEmail validates and executes the user's templates. html/template escapes every
// value, so service names and error messages cannot inject markup.
func renderEmail(subjectTpl, htmlTpl string, d emailData) (string, string, error) {
	st, err := textTemplate.New("subject").Parse(subjectTpl)
	if err != nil {
		return "", "", fmt.Errorf("modèle d'objet : %w", err)
	}
	ht, err := template.New("body").Parse(htmlTpl)
	if err != nil {
		return "", "", fmt.Errorf("modèle HTML : %w", err)
	}
	var sb, hb bytes.Buffer
	if err := st.Execute(&sb, d); err != nil {
		return "", "", fmt.Errorf("modèle d'objet : %w", err)
	}
	if err := ht.Execute(&hb, d); err != nil {
		return "", "", fmt.Errorf("modèle HTML : %w", err)
	}
	// Strip CR/LF: a subject must never be able to add mail headers.
	subj := strings.NewReplacer("\r", " ", "\n", " ").Replace(sb.String())
	return subj, hb.String(), nil
}

func (s *Server) sendAlert(evs []Event) error {
	subj, body, err := s.renderConfiguredAlert(s.emailData(evs))
	if err != nil {
		return err
	}
	return s.sendMail(subj, body)
}

func (s *Server) renderConfiguredAlert(d emailData) (string, string, error) {
	return s.renderAlert(s.getSetting("email_subject", defaultSubject), s.getSetting("email_mode", "blocks"),
		s.getSetting("email_html", defaultEmailHTML), s.getSetting("email_blocks", defaultEmailBlocks), d)
}

func (s *Server) sendMail(subject, htmlBody string) error {
	host := s.getSetting("smtp_host", "")
	port := s.getSetting("smtp_port", "587")
	mode := s.getSetting("smtp_tls", "starttls")
	user, pass := s.getSetting("smtp_user", ""), s.getSetting("smtp_pass", "")
	from, err := mail.ParseAddress(s.getSetting("smtp_from", ""))
	if err != nil || host == "" {
		return errors.New("SMTP non configuré : renseignez le serveur et l'expéditeur")
	}
	to, err := mail.ParseAddressList(s.getSetting("smtp_to", ""))
	if err != nil || len(to) == 0 {
		return errors.New("Aucun destinataire valide")
	}
	addr := net.JoinHostPort(host, port)
	tlsCfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}

	var conn net.Conn
	d := &net.Dialer{Timeout: 15 * time.Second}
	if mode == "tls" {
		conn, err = tls.DialWithDialer(d, "tcp", addr, tlsCfg)
	} else {
		conn, err = d.Dial("tcp", addr)
	}
	if err != nil {
		return err
	}
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if mode == "starttls" {
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS : %w", err)
		}
	}
	if user != "" {
		// net/smtp refuses PLAIN auth over an unencrypted connection, which is what we want.
		if err := c.Auth(smtp.PlainAuth("", user, pass, host)); err != nil {
			return fmt.Errorf("authentification SMTP : %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return err
	}
	var rcpts []string
	for _, a := range to {
		if err := c.Rcpt(a.Address); err != nil {
			return err
		}
		rcpts = append(rcpts, a.String())
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	msg := "From: " + from.String() + "\r\n" +
		"To: " + strings.Join(rcpts, ", ") + "\r\n" +
		"Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n" +
		"Date: " + time.Now().Format(time.RFC1123Z) + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n" +
		"Content-Transfer-Encoding: 8bit\r\n\r\n" +
		strings.ReplaceAll(strings.ReplaceAll(htmlBody, "\r\n", "\n"), "\n", "\r\n")
	if _, err := wc.Write([]byte(msg)); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}
