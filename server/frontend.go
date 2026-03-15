package main

import (
	"embed"
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

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the exact file first
		path := r.URL.Path
		if path == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}

		// Strip leading slash for fs operations
		fsPath := strings.TrimPrefix(path, "/")

		// Check if the file exists in the embedded FS
		if f, err := sub.Open(fsPath); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA fallback: serve index.html for non-file paths
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
