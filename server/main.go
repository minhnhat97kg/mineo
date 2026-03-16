package main

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gorilla/websocket"
)

func main() {
	// ── Resolve paths ─────────────────────────────────────────────────
	configPath := os.Getenv("MINEO_CONFIG")
	if configPath == "" {
		// Default: config.json next to the binary
		exe, _ := os.Executable()
		exeDir := filepath.Dir(exe)
		configPath = filepath.Join(exeDir, "config.json")
		// Fallback for `go run .` (binary in /tmp): check cwd
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			cwd, _ := os.Getwd()
			configPath = filepath.Join(cwd, "config.json")
		}
	}

	// Make configPath absolute so all derived paths are stable
	configPath, _ = filepath.Abs(configPath)

	secretPath := filepath.Join(filepath.Dir(configPath), ".secret")

	// appDir is the directory containing config.json (project root)
	appDir := filepath.Dir(configPath)

	// ── Load configuration ────────────────────────────────────────────
	cfg := LoadConfig(configPath)
	secret, err := LoadOrCreateSecret(secretPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
	cfg.Secret = secret

	// ── Validate startup preconditions ────────────────────────────────
	ValidateStartup(cfg)

	// ── Create PTY manager ────────────────────────────────────────────
	ptyMgr := NewPtyManager(cfg, appDir)

	// ── WebSocket upgrader (shared) ───────────────────────────────────
	allowedOrigins := buildAllowedOrigins(cfg.Port)
	upgrader := &websocket.Upgrader{
		CheckOrigin: makeCheckOrigin(allowedOrigins),
	}

	// ── HTTP mux (Go 1.22+ pattern matching) ──────────────────────────
	mux := http.NewServeMux()

	// ── Auth ──────────────────────────────────────────────────────────
	sessionStore := RegisterAuth(mux, cfg.Password, secret)

	// ── WebSocket routes ──────────────────────────────────────────────
	// Wrap WS handlers with auth check
	RegisterPtyWebSocketsWithAuth(mux, upgrader, ptyMgr, sessionStore)
	RegisterFileWatchWithAuth(mux, cfg.Workspace, upgrader, sessionStore)
	lspMgr := NewLspServerManager(upgrader)
	RegisterLspWithAuth(mux, lspMgr, sessionStore)

	// ── API routes ────────────────────────────────────────────────────
	// lspMgr must be created first so the API routes can reference it
	RegisterAPIRoutes(mux, cfg, ptyMgr, configPath, lspMgr)

	// ── Plugin routes ─────────────────────────────────────────────────
	MountPlugins(mux, cfg)

	// ── Frontend (embedded static files) ──────────────────────────────
	RegisterFrontend(mux)

	// ── Wrap mux with auth middleware ─────────────────────────────────
	var handler http.Handler = mux
	handler = NewAuthMiddleware(cfg.Password, sessionStore, handler)

	// ── Start server ──────────────────────────────────────────────────
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	server := &http.Server{
		Addr:    addr,
		Handler: handler,
	}

	log.Printf("Mineo running at http://%s", addr)
	log.Printf("Workspace: %s", cfg.Workspace)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server failed: %v", err)
	}
}

// buildAllowedOrigins returns the list of permitted WebSocket origins.
// It always includes localhost and 127.0.0.1 on the configured port, and
// any extra origins from the MINEO_ALLOWED_ORIGINS environment variable
// (comma-separated).
func buildAllowedOrigins(port int) []string {
	origins := []string{
		fmt.Sprintf("http://localhost:%d", port),
		fmt.Sprintf("http://127.0.0.1:%d", port),
	}
	if extra := os.Getenv("MINEO_ALLOWED_ORIGINS"); extra != "" {
		for _, o := range strings.Split(extra, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
	}
	return origins
}

// makeCheckOrigin returns a gorilla/websocket CheckOrigin function that only
// allows same-origin connections. A request is considered same-origin when:
//   - it has no Origin header (non-browser / curl client), or
//   - the Origin's host:port matches the request's Host header (standard browser same-origin), or
//   - the origin appears in the explicit allowedOrigins list (e.g. for reverse-proxy setups).
//
// This replaces the previous "return true" catch-all while still working for
// every normal Mineo deployment (direct browser access, LAN IP, custom domain).
func makeCheckOrigin(allowedOrigins []string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients (curl, native WS libs, etc.)
		}

		// Parse origin to extract its host
		originURL, err := url.Parse(origin)
		if err != nil {
			log.Printf("ws: rejected malformed origin %q", origin)
			return false
		}

		// Same-origin: origin host matches the Host header the server received
		// (handles localhost, LAN IPs, custom hostnames, and custom ports transparently)
		if strings.EqualFold(originURL.Host, r.Host) {
			return true
		}

		// Explicit allowlist (env var MINEO_ALLOWED_ORIGINS — for reverse-proxy scenarios)
		for _, a := range allowedOrigins {
			if strings.EqualFold(origin, a) {
				return true
			}
		}

		log.Printf("ws: rejected origin %q (host=%q, r.Host=%q)", origin, originURL.Host, r.Host)
		return false
	}
}

// RegisterPtyWebSocketsWithAuth wraps PTY WebSocket handlers with auth gating.
func RegisterPtyWebSocketsWithAuth(mux *http.ServeMux, upgrader *websocket.Upgrader, ptyMgr *PtyManager, store *SessionStore) {
	innerMux := http.NewServeMux()
	RegisterPtyWebSockets(innerMux, upgrader, ptyMgr)

	// Re-register each path on the outer mux with auth check
	wsAuthWrap := func(pattern string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if !AuthorizeWS(r, store) {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			innerMux.ServeHTTP(w, r)
		})
	}

	wsAuthWrap("/services/pty/control")
	wsAuthWrap("/pty/")
}

// RegisterFileWatchWithAuth wraps file-watch WebSocket with auth gating.
func RegisterFileWatchWithAuth(mux *http.ServeMux, workspace string, upgrader *websocket.Upgrader, store *SessionStore) {
	fw := NewFileWatcher(workspace, upgrader)
	fw.Start()

	mux.HandleFunc("/services/file-watch", func(w http.ResponseWriter, r *http.Request) {
		if !AuthorizeWS(r, store) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		fw.ServeHTTP(w, r)
	})
}

// RegisterLspWithAuth wraps LSP WebSocket with auth gating.
func RegisterLspWithAuth(mux *http.ServeMux, lspMgr *LspServerManager, store *SessionStore) {
	innerMux := http.NewServeMux()
	lspMgr.RegisterLspWebSockets(innerMux)

	mux.HandleFunc("/lsp/", func(w http.ResponseWriter, r *http.Request) {
		if !AuthorizeWS(r, store) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		innerMux.ServeHTTP(w, r)
	})
}
