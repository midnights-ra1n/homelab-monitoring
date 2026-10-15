package main

// Meross smart plugs. Privacy: the Meross cloud is contacted only when the user clicks
// "connect", to fetch the account key and the device names, then the session is logged out.
// The password is never stored. Every reading afterwards is made on the LAN, straight to the plug.

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Public constant of the Meross app, used to sign cloud requests (not a secret of ours).
const merossSecret = "23x17ahWarFH6w29"

var merossRegions = map[string]string{"eu": "https://iotx-eu.meross.com", "us": "https://iotx-us.meross.com", "ap": "https://iotx-ap.meross.com"}

func md5hex(s string) string {
	h := md5.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// checkMeross reads the instant power of a plug through its local HTTP API.
func checkMeross(ctx context.Context, m *Monitor, key string) checkResult {
	if key == "" {
		return checkResult{StatusUnknown, nil, "Compte Meross non connecté (Configuration → Meross)", nil, nil}
	}
	mid, ts := randHex(16), time.Now().Unix()
	body, _ := json.Marshal(map[string]any{
		"header": map[string]any{"messageId": mid, "namespace": "Appliance.Control.Electricity", "method": "GET", "payloadVersion": 1,
			"from": "http://" + m.Target + "/config", "timestamp": ts, "timestampMs": 0, "sign": md5hex(mid + key + strconv.FormatInt(ts, 10))},
		"payload": map[string]any{"electricity": map[string]int{"channel": m.Config.Channel}},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", "http://"+m.Target+"/config", bytes.NewReader(body))
	if err != nil {
		return checkResult{StatusMajor, nil, err.Error(), nil, nil}
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return checkResult{StatusMajor, nil, "Prise injoignable : " + err.Error(), nil, nil}
	}
	defer resp.Body.Close()
	lat := ms(time.Since(start))
	var out struct {
		Payload struct {
			Electricity *struct{ Power, Voltage, Current float64 } `json:"electricity"`
			Error       *struct {
				Code   int    `json:"code"`
				Detail string `json:"detail"`
			} `json:"error"`
		} `json:"payload"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil || resp.StatusCode != 200 {
		return checkResult{StatusMinor, lat, fmt.Sprintf("Réponse illisible de la prise (HTTP %d)", resp.StatusCode), nil, nil}
	}
	if e := out.Payload.Error; e != nil {
		return checkResult{StatusMinor, lat, fmt.Sprintf("Refus de la prise (%d %s) : clé Meross incorrecte ?", e.Code, e.Detail), nil, nil}
	}
	el := out.Payload.Electricity
	if el == nil {
		return checkResult{StatusMinor, lat, "Cette prise ne mesure pas la consommation", nil, nil}
	}
	// The plug reports mW, dV and mA.
	res := valueResult(&m.Config, lat, el.Power/1000, "W")
	if res.status == StatusOperational {
		res.message += fmt.Sprintf(" · %s V · %s A", frNum(el.Voltage/10, 1), frNum(el.Current/1000, 2))
	}
	return res
}

type merossDevice struct {
	UUID   string `json:"uuid"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Online bool   `json:"online"`
}

// merossCall sends a signed request to the Meross cloud and returns its data field.
func merossCall(ctx context.Context, base, path, token string, params any) (json.RawMessage, int, error) {
	p, _ := json.Marshal(params)
	enc := base64.StdEncoding.EncodeToString(p)
	nonce, ts := strings.ToUpper(randHex(8)), time.Now().UnixMilli()
	body, _ := json.Marshal(map[string]any{"params": enc, "sign": md5hex(merossSecret + strconv.FormatInt(ts, 10) + nonce + enc), "timestamp": ts, "nonce": nonce})
	req, err := http.NewRequestWithContext(ctx, "POST", base+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", strings.TrimSpace("Basic "+token))
	req.Header.Set("vender", "meross")
	req.Header.Set("AppVersion", "0.4.6.0")
	req.Header.Set("AppType", "MerossIOT")
	req.Header.Set("AppLanguage", "EN")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var out struct {
		APIStatus int             `json:"apiStatus"`
		Info      string          `json:"info"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, 0, fmt.Errorf("réponse illisible du cloud Meross (HTTP %d)", resp.StatusCode)
	}
	if out.APIStatus != 0 {
		return out.Data, out.APIStatus, fmt.Errorf("Meross a refusé la requête (%d %s)", out.APIStatus, out.Info)
	}
	return out.Data, 0, nil
}

// merossLogin fetches the account key and the device list, then closes the cloud session.
func merossLogin(ctx context.Context, base, email, password, mfa string) (string, []merossDevice, error) {
	params := map[string]any{"email": email, "password": md5hex(password), "encryption": 1, "agree": 0,
		"mobileInfo": map[string]string{"deviceModel": "hlm", "mobileOsVersion": "", "mobileOs": "Linux", "uuid": randHex(16), "carrier": ""}}
	if mfa != "" {
		params["mfaCode"] = mfa
	}
	var login struct{ Token, Key, Domain string }
	data, code, err := merossCall(ctx, base, "/v1/Auth/signIn", "", params)
	if code == 1030 { // account lives in another region: retry once there
		json.Unmarshal(data, &login)
		u, perr := url.Parse(login.Domain)
		if perr != nil || u.Scheme != "https" || !strings.HasSuffix(u.Hostname(), ".meross.com") {
			return "", nil, errors.New("redirection Meross refusée : " + login.Domain)
		}
		base = "https://" + u.Host
		data, _, err = merossCall(ctx, base, "/v1/Auth/signIn", "", params)
	}
	if err != nil {
		return "", nil, err
	}
	if err := json.Unmarshal(data, &login); err != nil || login.Key == "" || login.Token == "" {
		return "", nil, errors.New("réponse de connexion Meross inattendue")
	}
	defer merossCall(context.WithoutCancel(ctx), base, "/v1/Profile/logout", login.Token, map[string]any{})
	devices := []merossDevice{}
	if data, _, err := merossCall(ctx, base, "/v1/Device/devList", login.Token, map[string]any{}); err == nil {
		var list []struct {
			UUID         string `json:"uuid"`
			DevName      string `json:"devName"`
			DeviceType   string `json:"deviceType"`
			OnlineStatus int    `json:"onlineStatus"`
		}
		json.Unmarshal(data, &list)
		for _, d := range list {
			devices = append(devices, merossDevice{d.UUID, d.DevName, d.DeviceType, d.OnlineStatus == 1})
		}
	}
	return login.Key, devices, nil
}

func (s *Server) handleMerossLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		MFA      string `json:"mfa_code"`
		Region   string `json:"region"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	base, ok := merossRegions[in.Region]
	if !ok || in.Email == "" || in.Password == "" || len(in.Email) > 254 || len(in.Password) > 256 || len(in.MFA) > 12 {
		writeErr(w, 400, "Adresse e-mail, mot de passe et région (eu, us ou ap) requis")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	key, devices, err := merossLogin(ctx, base, in.Email, in.Password, in.MFA)
	if err != nil {
		writeErr(w, 502, "Connexion Meross impossible : "+err.Error())
		return
	}
	if err := s.setSetting("meross_key", key); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"devices": devices})
}
