package main

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:client_dist
var clientDist embed.FS

// RegisterFrontend registers the static file server for the embedded frontend.
// It serves files from the embedded client_dist directory and falls back to
// index.html for SPA routing (any path that doesn't match a static file).
func RegisterFrontend(mux *http.ServeMux) {
	sub, err := fs.Sub(clientDist, "client_dist")
	if err != nil {
		// If client_dist doesn't exist in embed, serve nothing
		return
	}

	fileServer := http.FileServer(http.FS(sub))

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		f, err := sub.Open("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", stat.ModTime(), f.(io.ReadSeeker))
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			serveIndex(w, r)
			return
		}

		// Strip leading slash for fs operations
		fsPath := strings.TrimPrefix(path, "/")

		// Check if the file exists in the embedded FS
		if f, err := sub.Open(fsPath); err == nil {
			stat, _ := f.Stat()
			f.Close()
			// Don't serve directories — fall through to SPA
			if stat != nil && !stat.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// SPA fallback: serve index.html for non-file paths
		serveIndex(w, r)
	})
}
