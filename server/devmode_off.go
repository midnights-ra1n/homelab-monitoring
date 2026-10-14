//go:build !devmode

package main

import "context"

// Release builds never contain the test mode: there is no flag or variable to turn it on,
// the code below is all that gets compiled. See devmode.go.
const devMode = false

func (s *Server) initDevMode(context.Context) error { return nil }
