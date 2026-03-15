package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

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

	// ── Validate startup preconditions ────────────────────────────────
	ValidateStartup(cfg)

	// ── Create PTY manager ────────────────────────────────────────────
	ptyMgr := NewPtyManager(cfg, appDir)

	// ── WebSocket upgrader (shared) ───────────────────────────────────
	upgrader := &websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true // Allow all origins (same as the Node server)
		},
	}

	// ── HTTP mux (Go 1.22+ pattern matching) ──────────────────────────
	mux := http.NewServeMux()

	// ── Auth ──────────────────────────────────────────────────────────
	sessionStore := RegisterAuth(mux, cfg.Password, secret)

	// ── API routes ────────────────────────────────────────────────────
	RegisterAPIRoutes(mux, cfg, ptyMgr, configPath)

	// ── WebSocket routes ──────────────────────────────────────────────
	// Wrap WS handlers with auth check
	RegisterPtyWebSocketsWithAuth(mux, upgrader, ptyMgr, sessionStore)
	RegisterFileWatchWithAuth(mux, cfg.Workspace, upgrader, sessionStore)
	lspMgr := NewLspServerManager(upgrader)
	RegisterLspWithAuth(mux, lspMgr, sessionStore)

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
