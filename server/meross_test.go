package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// fakePlug answers like a Meross plug, verifying the request signature.
func fakePlug(t *testing.T, key string, powerMW float64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Header struct {
				MessageID string `json:"messageId"`
				Timestamp int64  `json:"timestamp"`
				Sign      string `json:"sign"`
				Namespace string `json:"namespace"`
			} `json:"header"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		h := req.Header
		if r.URL.Path != "/config" || h.Namespace != "Appliance.Control.Electricity" || h.Sign != md5hex(h.MessageID+key+strconv.FormatInt(h.Timestamp, 10)) {
			w.Write([]byte(`{"payload":{"error":{"code":5001,"detail":"sign error"}}}`))
			return
		}
		w.Write([]byte(`{"payload":{"electricity":{"channel":0,"power":` + strconv.FormatFloat(powerMW, 'f', 0, 64) + `,"voltage":2301,"current":540}}}`))
	}))
}

func TestMerossCheck(t *testing.T) {
	plug := fakePlug(t, "k3y", 120500)
	defer plug.Close()
	m := Monitor{Name: "NAS", Type: "meross", Target: strings.TrimPrefix(plug.URL, "http://"), TimeoutS: 5, IntervalS: 60}
	if msg := m.validate(); msg != "" {
		t.Fatal(msg)
	}
	res := checkMeross(context.Background(), &m, "k3y")
	if res.status != StatusOperational || res.value == nil || *res.value != 120.5 || !strings.Contains(res.message, "230,1 V") {
		t.Fatalf("got %+v", res)
	}
	m.Config.MaxValue = f(100)
	if res := checkMeross(context.Background(), &m, "k3y"); res.status != StatusDegraded || !strings.Contains(res.message, "seuil") {
		t.Fatalf("threshold: got %+v", res)
	}
	if res := checkMeross(context.Background(), &m, "wrong"); res.status != StatusMinor {
		t.Fatalf("bad key: got %+v", res)
	}
	if res := checkMeross(context.Background(), &m, ""); res.status != StatusUnknown {
		t.Fatalf("no key: got %+v", res)
	}
}

func TestEnergyReport(t *testing.T) {
	s, _ := newTestServer(t)
	m := Monitor{Name: "Frigo", Type: "meross", Target: "192.168.1.20", IntervalS: 3600, TimeoutS: 10}
	m.validate()
	id, err := s.insertMonitor(&m)
	if err != nil {
		t.Fatal(err)
	}
	mons, _ := s.loadMonitors("WHERE id=?", id)
	for _, w := range []float64{100, 50} { // two hourly readings: 150 Wh today
		if err := s.recordResult(&mons[0], checkResult{status: StatusOperational, value: f(w)}, StatusOperational); err != nil {
			t.Fatal(err)
		}
	}
	from, to, _ := lastDays(httptest.NewRequest("GET", "/?days=7", nil))
	rep, err := s.energyReport(from, to)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Days) != 7 || len(rep.Plugs) != 1 || rep.TotalWh != 150 || *rep.AvgDayWh != 150 || *rep.AvgWeekWh != 1050 || rep.Plugs[0].Daily[6] == nil {
		t.Fatalf("got %+v", rep)
	}
}

func TestMonitorSecretsRedacted(t *testing.T) {
	s, ts := newTestServer(t)
	cookie := setupAdmin(t, s, ts)
	_, created := do(t, ts, "POST", "/api/monitors", cookie, map[string]any{"name": "Switch", "type": "snmp", "target": "192.168.1.2",
		"config": map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "snmp_version": "3", "snmp_user": "mon", "auth_proto": "SHA", "auth_pass": "s3cret-auth", "priv_proto": "AES", "priv_pass": "s3cret-priv"}})
	b, _ := json.Marshal(created)
	if strings.Contains(string(b), "s3cret") {
		t.Fatalf("secret leaked: %s", b)
	}
	id := int64(created["id"].(float64))
	// An edit that leaves the passwords empty keeps the saved ones.
	cfg := created["config"].(map[string]any)
	resp, _ := do(t, ts, "PUT", "/api/monitors/"+strconv.FormatInt(id, 10), cookie, map[string]any{"name": "Switch", "type": "snmp", "target": "192.168.1.2", "config": cfg})
	if resp.StatusCode != 200 {
		t.Fatalf("update: %d", resp.StatusCode)
	}
	mons, _ := s.loadMonitors("WHERE id=?", id)
	if c := mons[0].Config; c.AuthPass != "s3cret-auth" || c.PrivPass != "s3cret-priv" {
		t.Fatalf("secrets lost: %+v", c)
	}
	bad := Monitor{Name: "x", Type: "snmp", Target: "h", Config: MonitorConfig{OID: "sysUpTime"}}
	if bad.validate() == "" {
		t.Fatal("non-numeric OID must be rejected")
	}
}
