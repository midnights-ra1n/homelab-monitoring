package main

// Time zone used for every date the server writes (e-mails, reports, probe messages).
// The container runs in UTC; the zone comes from the "timezone" setting instead.

import (
	"sync/atomic"
	"time"
	_ "time/tzdata" // the distroless image has no /usr/share/zoneinfo
)

const defaultTimezone = "Europe/Paris"

var tzLoc atomic.Pointer[time.Location]

// localTZ returns the configured zone (UTC until the settings are loaded).
func localTZ() *time.Location {
	if l := tzLoc.Load(); l != nil {
		return l
	}
	return time.UTC
}

func (s *Server) loadTimezone() {
	if l, err := time.LoadLocation(s.getSetting("timezone", defaultTimezone)); err == nil {
		tzLoc.Store(l)
	}
}
