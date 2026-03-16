package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
)

// FileWatcher watches the workspace for changes and broadcasts to WebSocket clients.
type FileWatcher struct {
	workspace string
	upgrader  *websocket.Upgrader
	clients   map[*websocket.Conn]struct{}
	clientsMu sync.Mutex
	watcher   *fsnotify.Watcher
}

const maxFileWatchClients = 50

// NewFileWatcher creates a new file watcher for the given workspace.
func NewFileWatcher(workspace string, upgrader *websocket.Upgrader) *FileWatcher {
	return &FileWatcher{
		workspace: workspace,
		upgrader:  upgrader,
		clients:   make(map[*websocket.Conn]struct{}),
	}
}

// Start begins watching the workspace directory.
func (fw *FileWatcher) Start() {
	fw.startWatcher()
}

func (fw *FileWatcher) startWatcher() {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("[file-watch] failed to create watcher: %v", err)
		return
	}
	fw.watcher = watcher

	// Walk directory tree and add all directories
	filepath.Walk(fw.workspace, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			name := info.Name()
			// Skip hidden dirs and common large dirs
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" || name == "dist" {
				if path != fw.workspace { // don't skip workspace root even if named "dist"
					return filepath.SkipDir
				}
			}
			watcher.Add(path)
		}
		return nil
	})

	// Debounce and broadcast goroutine
	go func() {
		var debounceTimer *time.Timer
		pendingDirs := make(map[string]struct{})
		var pendingMu sync.Mutex

		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}

				// Compute parent directory of the changed file
				dir := filepath.Dir(event.Name)

				pendingMu.Lock()
				pendingDirs[dir] = struct{}{}

				// If a new directory was created, add it to the watcher
				if event.Has(fsnotify.Create) {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						watcher.Add(event.Name)
					}
				}

				if debounceTimer != nil {
					debounceTimer.Stop()
				}
				debounceTimer = time.AfterFunc(300*time.Millisecond, func() {
					pendingMu.Lock()
					dirs := make([]string, 0, len(pendingDirs))
					for d := range pendingDirs {
						dirs = append(dirs, d)
					}
					pendingDirs = make(map[string]struct{})
					pendingMu.Unlock()

					for _, d := range dirs {
						fw.broadcast(d)
					}
				})
				pendingMu.Unlock()

			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log.Printf("[file-watch] watcher error: %v", err)
				// Restart watcher on error
				watcher.Close()
				time.Sleep(2 * time.Second)
				fw.startWatcher()
				return
			}
		}
	}()
}

// broadcast sends a change event to all connected WebSocket clients.
func (fw *FileWatcher) broadcast(dir string) {
	msg, _ := json.Marshal(map[string]string{
		"type": "change",
		"dir":  dir,
	})

	fw.clientsMu.Lock()
	defer fw.clientsMu.Unlock()

	for conn := range fw.clients {
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			conn.Close()
			delete(fw.clients, conn)
		}
	}
}

// ServeHTTP handles the WebSocket upgrade for /services/file-watch.
func (fw *FileWatcher) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fw.clientsMu.Lock()
	if len(fw.clients) >= maxFileWatchClients {
		fw.clientsMu.Unlock()
		http.Error(w, "too many watchers", http.StatusServiceUnavailable)
		return
	}
	fw.clientsMu.Unlock()

	conn, err := fw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[file-watch] upgrade failed: %v", err)
		return
	}

	fw.clientsMu.Lock()
	fw.clients[conn] = struct{}{}
	fw.clientsMu.Unlock()

	// Read loop just to detect close
	go func() {
		defer func() {
			fw.clientsMu.Lock()
			delete(fw.clients, conn)
			fw.clientsMu.Unlock()
			conn.Close()
		}()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	}()
}

// RegisterFileWatch registers the file-watch WebSocket endpoint.
func RegisterFileWatch(mux *http.ServeMux, workspace string, upgrader *websocket.Upgrader) *FileWatcher {
	fw := NewFileWatcher(workspace, upgrader)
	fw.Start()
	mux.HandleFunc("/services/file-watch", fw.ServeHTTP)
	return fw
}
