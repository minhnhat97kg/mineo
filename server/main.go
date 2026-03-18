package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
	"mineo/server/internal/api"
	"mineo/server/internal/auth"
	"mineo/server/internal/config"
	"mineo/server/internal/lsp"
	"mineo/server/internal/plugin"
	"mineo/server/internal/tmux"
	"mineo/server/internal/ws"
)

func main() {
	// ── CLI flags (override config file) ──────────────────────────────
	flagPassword  := flag.String("password", "", "Password to protect the server (overrides config.json)")
	flagAddress   := flag.String("address", "", "Listen address, e.g. 0.0.0.0:3000 (overrides config.json port)")
	flagWorkspace := flag.String("workspace", "", "Workspace directory (overrides config.json)")
	flagConfig    := flag.String("config", "", "Path to config.json (default: next to binary)")
	flag.Parse()

	// ── Resolve paths ─────────────────────────────────────────────────
	configPath := *flagConfig
	if configPath == "" {
		configPath = os.Getenv("MINEO_CONFIG")
	}
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
	cfg := config.LoadConfig(configPath)
	secret, err := config.LoadOrCreateSecret(secretPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
	cfg.Secret = secret

	// ── Apply CLI flag overrides ───────────────────────────────────────
	if *flagPassword != "" {
		cfg.Password = *flagPassword
	}
	if *flagWorkspace != "" {
		cfg.Workspace = *flagWorkspace
	}
	if *flagAddress != "" {
		// Parse port from address for internal use
		parts := strings.SplitN(*flagAddress, ":", 2)
		if len(parts) == 2 {
			var port int
			if _, err := fmt.Sscanf(parts[1], "%d", &port); err == nil && port > 0 {
				cfg.Port = port
			}
		}
	}

	// ── Validate startup preconditions ────────────────────────────────
	api.ValidateStartup(cfg)

	// ── Create Tmux manager ───────────────────────────────────────────
	tmuxMgr := tmux.NewTmuxManager(cfg, appDir)

	// ── WebSocket upgrader (shared) ───────────────────────────────────
	allowedOrigins := buildAllowedOrigins(cfg.Port)
	upgrader := &websocket.Upgrader{
		CheckOrigin: makeCheckOrigin(allowedOrigins),
	}

	// ── HTTP mux (Go 1.22+ pattern matching) ──────────────────────────
	mux := http.NewServeMux()

	// ── Auth ──────────────────────────────────────────────────────────
	sessionStore := auth.RegisterAuth(mux, cfg.Password, secret)

	// ── WebSocket routes ──────────────────────────────────────────────
	registerPtyWithAuth(mux, upgrader, tmuxMgr, sessionStore)
	registerFileWatchWithAuth(mux, cfg.Workspace, upgrader, sessionStore)
	lspMgr := lsp.NewLspServerManager(upgrader)
	registerLspWithAuth(mux, lspMgr, sessionStore)

	// ── API routes ────────────────────────────────────────────────────
	api.RegisterAPIRoutes(mux, cfg, tmuxMgr, configPath, lspMgr)

	// ── Plugin routes ─────────────────────────────────────────────────
	plugin.MountPlugins(mux, cfg)

	// ── Frontend (embedded static files) ──────────────────────────────
	RegisterFrontend(mux)

	// ── Wrap mux with auth middleware ─────────────────────────────────
	var handler http.Handler = mux
	handler = auth.NewAuthMiddleware(cfg.Password, sessionStore, handler)

	// ── Start server ──────────────────────────────────────────────────
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	if *flagAddress != "" {
		addr = *flagAddress
	}
	server := &http.Server{
		Addr:    addr,
		Handler: handler,
	}

	// ── Graceful shutdown ─────────────────────────────────────────────
	// On SIGINT/SIGTERM: detach all windows (tmux session stays alive)
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("[shutdown] Detaching all tmux windows (session stays alive)...")
		tmuxMgr.DetachAll()
		server.Close()
	}()

	log.Printf("Mineo running at http://%s", addr)
	log.Printf("Workspace: %s", cfg.Workspace)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server failed: %v", err)
	}
}

// buildAllowedOrigins returns the list of permitted WebSocket origins.
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
// allows same-origin connections.
func makeCheckOrigin(allowedOrigins []string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients (curl, native WS libs, etc.)
		}

		originURL, err := url.Parse(origin)
		if err != nil {
			log.Printf("ws: rejected malformed origin %q", origin)
			return false
		}

		if strings.EqualFold(originURL.Host, r.Host) {
			return true
		}

		for _, a := range allowedOrigins {
			if strings.EqualFold(origin, a) {
				return true
			}
		}

		log.Printf("ws: rejected origin %q (host=%q, r.Host=%q)", origin, originURL.Host, r.Host)
		return false
	}
}

func registerPtyWithAuth(mux *http.ServeMux, upgrader *websocket.Upgrader, tmuxMgr *tmux.TmuxManager, store *auth.SessionStore) {
	innerMux := http.NewServeMux()
	ws.RegisterPtyWebSockets(innerMux, upgrader, tmuxMgr)

	wsAuthWrap := func(pattern string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if !auth.AuthorizeWS(r, store) {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			innerMux.ServeHTTP(w, r)
		})
	}

	wsAuthWrap("/services/pty/control")
	wsAuthWrap("/pty/")
}

func registerFileWatchWithAuth(mux *http.ServeMux, workspace string, upgrader *websocket.Upgrader, store *auth.SessionStore) {
	fw := ws.NewFileWatcher(workspace, upgrader)
	fw.Start()

	mux.HandleFunc("/services/file-watch", func(w http.ResponseWriter, r *http.Request) {
		if !auth.AuthorizeWS(r, store) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		fw.ServeHTTP(w, r)
	})
}

func registerLspWithAuth(mux *http.ServeMux, lspMgr *lsp.LspServerManager, store *auth.SessionStore) {
	innerMux := http.NewServeMux()
	lspMgr.RegisterLspWebSockets(innerMux)

	mux.HandleFunc("/lsp/", func(w http.ResponseWriter, r *http.Request) {
		if !auth.AuthorizeWS(r, store) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		innerMux.ServeHTTP(w, r)
	})
}
