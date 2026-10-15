package main

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// The React app is built into web/dist (see ../web) and shipped inside the binary.
//
//go:embed all:web/dist
var webFS embed.FS

// Go's table lacks the PWA manifest type; browsers expect it to install the app.
func init() { _ = mime.AddExtensionType(".webmanifest", "application/manifest+json") }

func (s *Server) staticHandler() http.Handler {
	dist, _ := fs.Sub(webFS, "web/dist")
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, http.StatusMethodNotAllowed, "Méthode non autorisée")
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if strings.HasPrefix(p, "api/") {
			writeErr(w, 404, "Route inconnue")
			return
		}
		if p == "" || p == "." {
			p = "index.html"
		}
		if _, err := fs.Stat(dist, p); err != nil {
			// Client-side routes (/status, /hosts/3 ...) all load the app shell.
			p = "index.html"
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + p
		if p == "index.html" {
			r2.URL.Path = "/" // FileServer redirects /index.html to /
		}
		files.ServeHTTP(w, r2)
	})
}
