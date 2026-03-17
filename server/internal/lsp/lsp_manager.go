package lsp

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// LSP_SERVERS maps language names to their server command + args.
var LSP_SERVERS = map[string][]string{
	"typescript": {"typescript-language-server", "--stdio"},
	"python":     {"pylsp"},
	"go":         {"gopls"},
	"rust":       {"rust-analyzer"},
	"lua":        {"lua-language-server", "--stdio"},
	"bash":       {"bash-language-server", "start"},
	"css":        {"vscode-css-language-server", "--stdio"},
	"html":       {"vscode-html-language-server", "--stdio"},
	"json":       {"vscode-json-language-server", "--stdio"},
	"yaml":       {"yaml-language-server", "--stdio"},
	"toml":       {"taplo", "lsp", "stdio"},
	"c":          {"clangd"},
	"cpp":        {"clangd"},
}

const (
	lspHeaderSep = "\r\n\r\n"
	lspCLPrefix  = "Content-Length: "
)

// lspPathRe matches /lsp/<lang>
var lspPathRe = regexp.MustCompile(`^/lsp/(\w+)$`)

// LspServerManager manages language server processes and WebSocket connections.
type LspServerManager struct {
	mu          sync.Mutex
	servers     map[string]*exec.Cmd
	serverIn    map[string]io.WriteCloser
	serverOut   map[string]*lspBroadcaster
	initialized map[string]bool
	upgrader    *websocket.Upgrader
}

// lspBroadcaster manages multiple listeners on a server's stdout.
type lspBroadcaster struct {
	mu        sync.Mutex
	listeners map[*websocket.Conn]struct{}
}

func newLspBroadcaster() *lspBroadcaster {
	return &lspBroadcaster{
		listeners: make(map[*websocket.Conn]struct{}),
	}
}

func (b *lspBroadcaster) add(conn *websocket.Conn) {
	b.mu.Lock()
	b.listeners[conn] = struct{}{}
	b.mu.Unlock()
}

func (b *lspBroadcaster) remove(conn *websocket.Conn) {
	b.mu.Lock()
	delete(b.listeners, conn)
	b.mu.Unlock()
}

func (b *lspBroadcaster) broadcast(data []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for conn := range b.listeners {
		conn.WriteMessage(websocket.BinaryMessage, data)
	}
}

// NewLspServerManager creates a new LSP server manager.
func NewLspServerManager(upgrader *websocket.Upgrader) *LspServerManager {
	return &LspServerManager{
		servers:     make(map[string]*exec.Cmd),
		serverIn:    make(map[string]io.WriteCloser),
		serverOut:   make(map[string]*lspBroadcaster),
		initialized: make(map[string]bool),
		upgrader:    upgrader,
	}
}

// RegisterLspWebSockets registers the /lsp/<lang> WebSocket handler.
func (lm *LspServerManager) RegisterLspWebSockets(mux *http.ServeMux) {
	mux.HandleFunc("/lsp/", func(w http.ResponseWriter, r *http.Request) {
		m := lspPathRe.FindStringSubmatch(r.URL.Path)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		lang := m[1]
		cmd, ok := LSP_SERVERS[lang]
		if !ok {
			http.Error(w, "Unknown language server", http.StatusNotFound)
			return
		}

		// Check binary exists in PATH before attempting spawn
		if _, err := exec.LookPath(cmd[0]); err != nil {
			http.Error(w, fmt.Sprintf("%s language server not installed", lang), http.StatusServiceUnavailable)
			return
		}

		conn, err := lm.upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[lsp] %s upgrade failed: %v", lang, err)
			return
		}

		lm.handleConnection(conn, lang, cmd)
	})
}

func (lm *LspServerManager) handleConnection(conn *websocket.Conn, lang string, cmd []string) {
	lm.mu.Lock()

	// Ensure server process is running
	if _, running := lm.servers[lang]; !running {
		if err := lm.spawnServer(lang, cmd); err != nil {
			lm.mu.Unlock()
			log.Printf("[lsp] %s spawn failed: %v", lang, err)
			conn.Close()
			return
		}
	}

	stdin := lm.serverIn[lang]
	broadcaster := lm.serverOut[lang]
	isReconnect := lm.initialized[lang]
	lm.mu.Unlock()

	// Add this connection to the broadcaster
	broadcaster.add(conn)

	// Handle messages from WebSocket -> language server stdin
	var parser *LspParser
	initIntercepted := !isReconnect // fresh process: no intercept needed

	if isReconnect {
		parser = NewLspParser()
	}

	go func() {
		defer func() {
			broadcaster.remove(conn)
			conn.Close()
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}

			lm.mu.Lock()
			if _, running := lm.servers[lang]; !running {
				lm.mu.Unlock()
				return
			}
			lm.mu.Unlock()

			// Fast path: process is fresh or intercept already done — forward verbatim
			if initIntercepted {
				stdin.Write(raw)
				continue
			}

			// Intercept path: parse the stream looking for the initialize request
			msgs := parser.Push(raw)
			for _, msg := range msgs {
				msgMap, ok := msg.(map[string]interface{})
				if !ok {
					stdin.Write(FrameLsp(msg))
					continue
				}

				method, _ := msgMap["method"].(string)
				id := msgMap["id"]

				if method == "initialize" && id != nil {
					// Send synthetic initialize result back to the client
					syntheticResult := map[string]interface{}{
						"jsonrpc": "2.0",
						"id":     id,
						"result": map[string]interface{}{
							"capabilities": map[string]interface{}{
								"textDocumentSync":   map[string]interface{}{"openClose": true, "change": 1},
								"hoverProvider":      true,
								"completionProvider": map[string]interface{}{"triggerCharacters": []string{".", ":", "\"", "'", "/", "@", "<"}},
								"definitionProvider": true,
							},
						},
					}
					conn.WriteMessage(websocket.BinaryMessage, FrameLsp(syntheticResult))
					initIntercepted = true
					log.Printf("[lsp] %s initialize intercepted for reconnecting client", lang)
				} else {
					// All other messages go through
					stdin.Write(FrameLsp(msg))
				}
			}
		}
	}()
}

func (lm *LspServerManager) spawnServer(lang string, cmd []string) error {
	bin := cmd[0]
	args := cmd[1:]

	proc := exec.Command(bin, args...)
	proc.Stderr = &lspStderrLogger{lang: lang}

	stdin, err := proc.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := proc.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := proc.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	broadcaster := newLspBroadcaster()
	lm.servers[lang] = proc
	lm.serverIn[lang] = stdin
	lm.serverOut[lang] = broadcaster

	// Read stdout and broadcast to all connected clients
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				broadcaster.broadcast(data)

				// Mark as initialized once the server has replied
				lm.mu.Lock()
				if !lm.initialized[lang] {
					lm.initialized[lang] = true
					log.Printf("[lsp] %s marked as initialized", lang)
				}
				lm.mu.Unlock()
			}
			if err != nil {
				break
			}
		}

		// Process exited — clean up
		lm.mu.Lock()
		delete(lm.servers, lang)
		delete(lm.serverIn, lang)
		delete(lm.serverOut, lang)
		delete(lm.initialized, lang)
		lm.mu.Unlock()

		proc.Wait()
		log.Printf("[lsp] %s exited", lang)
	}()

	// Also monitor process death via error handler
	go func() {
		err := proc.Wait()
		if err != nil {
			log.Printf("[lsp] %s exited with error: %v", lang, err)
		}
		lm.mu.Lock()
		delete(lm.servers, lang)
		delete(lm.serverIn, lang)
		delete(lm.serverOut, lang)
		delete(lm.initialized, lang)
		lm.mu.Unlock()
	}()

	return nil
}

// lspStderrLogger logs language server stderr output.
type lspStderrLogger struct {
	lang string
}

func (l *lspStderrLogger) Write(p []byte) (n int, err error) {
	line := strings.TrimSpace(string(p))
	if line != "" {
		log.Printf("[lsp][%s] %s", l.lang, line)
	}
	return len(p), nil
}

// FrameLsp encodes a JSON-RPC object as a Content-Length-framed LSP message.
func FrameLsp(msg interface{}) []byte {
	body, _ := json.Marshal(msg)
	header := fmt.Sprintf("%s%d%s", lspCLPrefix, len(body), lspHeaderSep)
	return append([]byte(header), body...)
}

// LspParser is a stateful byte buffer that parses complete LSP JSON-RPC objects.
type LspParser struct {
	buf []byte
}

// NewLspParser creates a new LSP frame parser.
func NewLspParser() *LspParser {
	return &LspParser{}
}

// Push adds data to the buffer and returns any complete parsed JSON objects.
func (p *LspParser) Push(chunk []byte) []interface{} {
	p.buf = append(p.buf, chunk...)
	var msgs []interface{}

	for {
		raw := string(p.buf)
		sepIdx := strings.Index(raw, lspHeaderSep)
		if sepIdx == -1 {
			break
		}

		header := raw[:sepIdx]
		var contentLength int
		for _, line := range strings.Split(header, "\r\n") {
			if strings.HasPrefix(line, lspCLPrefix) {
				cl, err := strconv.Atoi(strings.TrimPrefix(line, lspCLPrefix))
				if err == nil {
					contentLength = cl
				}
				break
			}
		}
		if contentLength == 0 {
			break
		}

		headerBytes := len([]byte(raw[:sepIdx+len(lspHeaderSep)]))
		totalNeeded := headerBytes + contentLength
		if len(p.buf) < totalNeeded {
			break
		}

		bodyStr := string(p.buf[headerBytes:totalNeeded])
		p.buf = p.buf[totalNeeded:]

		var obj interface{}
		if err := json.Unmarshal([]byte(bodyStr), &obj); err == nil {
			msgs = append(msgs, obj)
		}
	}

	return msgs
}

// Stop terminates all running language servers.
func (lm *LspServerManager) Stop() {
	lm.mu.Lock()
	defer lm.mu.Unlock()

	for lang, proc := range lm.servers {
		log.Printf("[lsp] stopping %s", lang)
		if proc.Process != nil {
			proc.Process.Kill()
		}
	}
}

// LspServerStatus describes a single language server entry.
type LspServerStatus struct {
	Lang      string `json:"lang"`
	Bin       string `json:"bin"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
}

// StatusAll returns the status of every known language server.
func (lm *LspServerManager) StatusAll() []LspServerStatus {
	lm.mu.Lock()
	running := make(map[string]bool, len(lm.servers))
	for lang := range lm.servers {
		running[lang] = true
	}
	lm.mu.Unlock()

	// Stable sort order
	langs := make([]string, 0, len(LSP_SERVERS))
	for lang := range LSP_SERVERS {
		langs = append(langs, lang)
	}
	sort.Strings(langs)

	result := make([]LspServerStatus, 0, len(langs))
	for _, lang := range langs {
		cmd := LSP_SERVERS[lang]
		_, err := exec.LookPath(cmd[0])
		result = append(result, LspServerStatus{
			Lang:      lang,
			Bin:       cmd[0],
			Installed: err == nil,
			Running:   running[lang],
		})
	}
	return result
}

// StopLang kills the running server for a single language. Returns false if it
// was not running.
func (lm *LspServerManager) StopLang(lang string) bool {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	proc, ok := lm.servers[lang]
	if !ok {
		return false
	}
	log.Printf("[lsp] stopping %s (user request)", lang)
	if proc.Process != nil {
		proc.Process.Kill()
	}
	return true
}
