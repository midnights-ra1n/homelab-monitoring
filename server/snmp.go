package main

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

var oidRe = regexp.MustCompile(`^\.?[0-9]+(\.[0-9]+)+$`)

var snmpAuth = map[string]gosnmp.SnmpV3AuthProtocol{"MD5": gosnmp.MD5, "SHA": gosnmp.SHA, "SHA256": gosnmp.SHA256, "SHA512": gosnmp.SHA512}
var snmpPriv = map[string]gosnmp.SnmpV3PrivProtocol{"DES": gosnmp.DES, "AES": gosnmp.AES, "AES256": gosnmp.AES256}

func validateSNMP(m *Monitor) string {
	c := &m.Config
	if _, _, err := snmpAddr(m.Target); err != nil {
		return "La cible doit être un hôte, avec un port facultatif (161 par défaut)"
	}
	if !oidRe.MatchString(c.OID) {
		return "L'OID doit être numérique, par exemple 1.3.6.1.2.1.1.3.0"
	}
	if len(c.Unit) > 16 {
		return "L'unité doit contenir au plus 16 caractères"
	}
	switch c.SNMPVersion {
	case "":
		c.SNMPVersion = "2c"
		fallthrough
	case "1", "2c":
		if c.Community == "" {
			c.Community = "public"
		}
	case "3":
		if c.SNMPUser == "" {
			return "SNMPv3 nécessite un nom d'utilisateur"
		}
		if _, ok := snmpAuth[c.AuthProto]; c.AuthProto != "" && !ok {
			return "L'authentification SNMPv3 doit être MD5, SHA, SHA256 ou SHA512"
		}
		if _, ok := snmpPriv[c.PrivProto]; c.PrivProto != "" && !ok {
			return "Le chiffrement SNMPv3 doit être DES, AES ou AES256"
		}
		if c.PrivProto != "" && c.AuthProto == "" {
			return "Le chiffrement SNMPv3 nécessite aussi l'authentification"
		}
	default:
		return "La version SNMP doit être 1, 2c ou 3"
	}
	return ""
}

func snmpAddr(target string) (string, uint16, error) {
	if h, p, err := net.SplitHostPort(target); err == nil {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 || h == "" {
			return "", 0, fmt.Errorf("port invalide")
		}
		return h, uint16(n), nil
	}
	if target == "" || strings.ContainsAny(target, " /:@") {
		return "", 0, fmt.Errorf("hôte invalide")
	}
	return target, 161, nil
}

func checkSNMP(ctx context.Context, m *Monitor) checkResult {
	c := &m.Config
	host, port, _ := snmpAddr(m.Target)
	deadline, _ := ctx.Deadline()
	g := &gosnmp.GoSNMP{Target: host, Port: port, Context: ctx, Timeout: time.Until(deadline) / 2, Retries: 1, MaxOids: 1, Community: c.Community}
	switch c.SNMPVersion {
	case "1":
		g.Version = gosnmp.Version1
	case "3":
		g.Version, g.SecurityModel, g.Community = gosnmp.Version3, gosnmp.UserSecurityModel, ""
		usm := &gosnmp.UsmSecurityParameters{UserName: c.SNMPUser}
		g.MsgFlags = gosnmp.NoAuthNoPriv
		if c.AuthProto != "" {
			g.MsgFlags = gosnmp.AuthNoPriv
			usm.AuthenticationProtocol, usm.AuthenticationPassphrase = snmpAuth[c.AuthProto], c.AuthPass
		}
		if c.PrivProto != "" {
			g.MsgFlags = gosnmp.AuthPriv
			usm.PrivacyProtocol, usm.PrivacyPassphrase = snmpPriv[c.PrivProto], c.PrivPass
		}
		g.SecurityParameters = usm
	default:
		g.Version = gosnmp.Version2c
	}
	start := time.Now()
	if err := g.Connect(); err != nil {
		return checkResult{StatusMajor, nil, "Connexion SNMP impossible : " + err.Error(), nil, nil}
	}
	defer g.Conn.Close()
	pkt, err := g.Get([]string{c.OID})
	if err != nil {
		return checkResult{StatusMajor, nil, "Requête SNMP échouée : " + err.Error(), nil, nil}
	}
	lat := ms(time.Since(start))
	if pkt.Error != gosnmp.NoError || len(pkt.Variables) == 0 {
		return checkResult{StatusMinor, lat, "Erreur SNMP : " + pkt.Error.String(), nil, nil}
	}
	v := pkt.Variables[0]
	switch v.Type {
	case gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView, gosnmp.Null:
		return checkResult{StatusMinor, lat, "OID introuvable sur l'équipement", nil, nil}
	case gosnmp.OctetString:
		str := strings.TrimSpace(string(v.Value.([]byte)))
		if f, err := strconv.ParseFloat(str, 64); err == nil {
			return valueResult(c, lat, f, c.Unit)
		}
		if c.Expected != "" && !strings.Contains(str, c.Expected) {
			return checkResult{StatusMinor, lat, "Valeur inattendue : " + str, nil, nil}
		}
		return slowOrOK(c, lat, str)
	}
	f, _ := gosnmp.ToBigInt(v.Value).Float64()
	return valueResult(c, lat, f, c.Unit)
}

// valueResult checks a reading against the optional min/max thresholds.
func valueResult(c *MonitorConfig, lat *float64, v float64, unit string) checkResult {
	txt := strings.TrimSpace(frNum(v, 1) + " " + unit)
	res := slowOrOK(c, lat, txt)
	if c.MaxValue != nil && v > *c.MaxValue {
		res = checkResult{StatusDegraded, lat, fmt.Sprintf("%s au-dessus du seuil de %s %s", txt, frNum(*c.MaxValue, 1), unit), nil, nil}
	} else if c.MinValue != nil && v < *c.MinValue {
		res = checkResult{StatusDegraded, lat, fmt.Sprintf("%s sous le seuil de %s %s", txt, frNum(*c.MinValue, 1), unit), nil, nil}
	}
	res.value = &v
	return res
}
