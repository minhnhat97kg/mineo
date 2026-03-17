package tmux

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"mineo/server/internal/config"
)

// PaneRole describes the kind of PTY instance.
type PaneRole string

const (
	RoleNeovim   PaneRole = "neovim"
	RoleTerminal PaneRole = "terminal"
)

// DataListener receives PTY output as raw bytes.
type DataListener func(data []byte)

// colonCSIRe matches any CSI sequence that contains colon-separated subparams.
// xterm.js only understands semicolons as param separators; colons cause parse errors.
// Pattern: ESC [ <params-with-colons> <final-byte>
// We replace every colon inside the param area with a semicolon.
var colonCSIRe = regexp.MustCompile(`\x1b\[([0-9:;]*)([A-Za-z])`)

// TmuxWindow describes a single tmux window managed by Mineo.
type TmuxWindow struct {
	ID         string   // mineo instance ID (UUID), used as tmux window name
	Role       PaneRole // "neovim" or "terminal"
	SocketPath string   // neovim only: /tmp/mineo-nvim-<id>.sock
	TmuxIndex  int      // tmux window index (for commands)
}

// attachedWindow extends TmuxWindow with the live PTY bridge.
type attachedWindow struct {
	TmuxWindow
	ptmx       *os.File          // creack/pty fd for the `tmux attach` process
	cmd        *exec.Cmd         // the `tmux attach` subprocess
	listeners  map[string]DataListener
	listenerMu sync.Mutex
	disposed   bool
	nextListID int
}

// TmuxManager manages a tmux session and its windows.
type TmuxManager struct {
	mu         sync.RWMutex
	session    string                     // tmux session name
	instances  map[string]*attachedWindow // keyed by mineo instance ID
	primaryID  string                     // first neovim window
	cfg        *config.MineoCfg
	appDir     string
	layoutPath string // path to .mineo-layout.json
}

// NewTmuxManager creates a new TmuxManager, adopting an existing tmux session
// if one already exists for this workspace, or creating a new one.
func NewTmuxManager(cfg *config.MineoCfg, appDir string) *TmuxManager {
	// 1. Check tmux is installed
	if _, err := exec.LookPath("tmux"); err != nil {
		log.Fatalf("tmux is required but not found in PATH: %v", err)
	}

	// 2. Compute deterministic session name from workspace
	hash := sha256.Sum256([]byte(cfg.Workspace))
	sessionName := fmt.Sprintf("mineo-%x", hash[:4])

	layoutPath := filepath.Join(appDir, ".mineo-layout.json")

	tm := &TmuxManager{
		session:    sessionName,
		instances:  make(map[string]*attachedWindow),
		cfg:        cfg,
		appDir:     appDir,
		layoutPath: layoutPath,
	}

	// 3. Check if session exists
	checkCmd := tmuxCmd("has-session", "-t", sessionName)
	if err := checkCmd.Run(); err == nil {
		// Session exists — adopt windows
		log.Printf("[tmux] Adopting existing session %q", sessionName)
		tm.adoptExisting()
	} else {
		// Create new session
		log.Printf("[tmux] Creating new session %q", sessionName)
		createCmd := tmuxCmd("new-session", "-d", "-s", sessionName, "-x", "120", "-y", "30")
		if out, err := createCmd.CombinedOutput(); err != nil {
			log.Fatalf("[tmux] Failed to create session: %v\n%s", err, out)
		}

		// Configure the session
		tmuxSet := func(option, value string) {
			tmuxCmd("set-option", "-t", sessionName, option, value).Run()
		}
		tmuxSet("prefix", "None")
		tmuxSet("prefix2", "None")
		tmuxSet("mouse", "off")
		tmuxSet("status", "off")
		tmuxSet("remain-on-exit", "off")
		tmuxSet("window-size", "latest")
		tmuxSet("default-terminal", "xterm-256color")

		// Set environment
		tmuxCmd("set-environment", "-t", sessionName, "COLORTERM", "truecolor").Run()

		// Kill the default window 0 created by new-session
		tmuxCmd("kill-window", "-t", sessionName+":0").Run()
	}

	return tm
}

// adoptExisting rediscovers windows from an existing tmux session and attaches to them.
func (tm *TmuxManager) adoptExisting() {
	// List windows: index, name, pane_pid
	out, err := tmuxCmd("list-windows", "-t", tm.session,
		"-F", "#{window_index}\t#{window_name}").Output()
	if err != nil {
		log.Printf("[tmux] Failed to list windows: %v", err)
		return
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}

		indexStr := parts[0]
		windowName := parts[1]
		tmuxIndex, err := strconv.Atoi(indexStr)
		if err != nil {
			continue
		}

		// The window name is the mineo instance ID (we set it with -n on create)
		id := windowName

		// Determine role: check if nvim socket exists and is alive
		socketPath := fmt.Sprintf("/tmp/mineo-nvim-%s.sock", id)
		role := RoleTerminal
		if isNvimSocketAlive(socketPath) {
			role = RoleNeovim
		}

		win := TmuxWindow{
			ID:         id,
			Role:       role,
			SocketPath: "",
			TmuxIndex:  tmuxIndex,
		}
		if role == RoleNeovim {
			win.SocketPath = socketPath
		}

		log.Printf("[tmux] Adopting window %d %q (role=%s)", tmuxIndex, id, role)

		if err := tm.attach(id, &win); err != nil {
			log.Printf("[tmux] Failed to attach to window %q: %v", id, err)
			continue
		}

		// Track primary neovim
		if role == RoleNeovim && tm.primaryID == "" {
			tm.primaryID = id
		}
	}
}

// isNvimSocketAlive checks if a neovim socket file exists and accepts connections.
func isNvimSocketAlive(socketPath string) bool {
	if _, err := os.Stat(socketPath); os.IsNotExist(err) {
		return false
	}
	conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
	if err != nil {
		// Socket file exists but nvim is dead — stale socket
		return false
	}
	conn.Close()
	return true
}

// nvimConfigEnv returns extra env vars based on the configured nvim config mode.
func (tm *TmuxManager) nvimConfigEnv() []string {
	tm.cfg.Mu.RLock()
	mode := tm.cfg.Nvim.ConfigMode
	configDir := tm.cfg.Nvim.ConfigDir
	tm.cfg.Mu.RUnlock()

	bundledConfigDir := filepath.Join(tm.appDir, "nvim-config")

	switch mode {
	case config.NvimConfigBundled:
		return []string{"XDG_CONFIG_HOME=" + bundledConfigDir}
	case config.NvimConfigCustom:
		if configDir != "" {
			return []string{"XDG_CONFIG_HOME=" + configDir}
		}
	}
	// system mode: no XDG_CONFIG_HOME override
	return nil
}

// filterEnv removes a key from an env slice.
func filterEnv(env []string, key string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env))
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return out
}

// tmuxCmd creates an exec.Cmd for a tmux command with TMUX env var unset.
// This ensures tmux commands work even if the Mineo server runs inside tmux.
func tmuxCmd(args ...string) *exec.Cmd {
	cmd := exec.Command("tmux", args...)
	cmd.Env = filterEnv(os.Environ(), "TMUX")
	return cmd
}

// Spawn creates a new tmux window and attaches to it via a PTY bridge.
func (tm *TmuxManager) Spawn(id string, role PaneRole, cols, rows uint16, cwd string) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if _, exists := tm.instances[id]; exists {
		return fmt.Errorf("instance %s already exists", id)
	}

	// Resolve cwd
	resolvedCwd := tm.cfg.Workspace
	if cwd != "" && filepath.IsAbs(cwd) {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			resolvedCwd = cwd
		}
	}

	// Build the command that runs inside the tmux window
	var windowCmdArgs []string
	var socketPath string

	tm.cfg.Mu.RLock()
	nvimBin := tm.cfg.Nvim.Bin
	tm.cfg.Mu.RUnlock()

	if role == RoleNeovim {
		socketPath = fmt.Sprintf("/tmp/mineo-nvim-%s.sock", id)
		// Remove stale socket
		os.Remove(socketPath)

		// Set environment variables on the tmux session for nvim
		tmuxCmd("set-environment", "-t", tm.session, "TERM", "xterm-256color").Run()
		tmuxCmd("set-environment", "-t", tm.session, "COLORTERM", "truecolor").Run()

		// Apply nvim config env via tmux set-environment
		extraEnv := tm.nvimConfigEnv()
		for _, e := range extraEnv {
			parts := strings.SplitN(e, "=", 2)
			if len(parts) == 2 {
				tmuxCmd("set-environment", "-t", tm.session, parts[0], parts[1]).Run()
			}
		}

		// Use the nvim binary directly as the window command (no shell wrapping needed)
		// tmux new-window accepts command + args as separate arguments after flags
		windowCmdArgs = []string{nvimBin, "--listen", socketPath, "-c", "set mouse=a"}
	} else {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/bash"
		}
		windowCmdArgs = []string{shell}
	}

	// Create tmux window
	// tmux new-window -t <session> -n <id> -c <cwd> -P -F '#{window_index}' [cmd] [args...]
	newWinArgs := []string{"new-window",
		"-t", tm.session,
		"-n", id,
		"-c", resolvedCwd,
		"-P", "-F", "#{window_index}",
	}
	newWinArgs = append(newWinArgs, windowCmdArgs...)
	newWinCmd := tmuxCmd(newWinArgs...)
	out, err := newWinCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to create tmux window: %w (output: %s)", err, out)
	}

	tmuxIndex, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return fmt.Errorf("failed to parse tmux window index: %w", err)
	}

	win := &TmuxWindow{
		ID:         id,
		Role:       role,
		SocketPath: socketPath,
		TmuxIndex:  tmuxIndex,
	}

	// Attach to the window
	if err := tm.attachLocked(id, win); err != nil {
		// Try to clean up the window
		tmuxCmd("kill-window", "-t",
			fmt.Sprintf("%s:%d", tm.session, tmuxIndex)).Run()
		return err
	}

	// Resize the window to match the requested size
	if cols > 0 && rows > 0 {
		tmuxCmd("resize-window", "-t",
			fmt.Sprintf("%s:%d", tm.session, tmuxIndex),
			"-x", strconv.Itoa(int(cols)),
			"-y", strconv.Itoa(int(rows))).Run()
	}

	// Track primary neovim
	if role == RoleNeovim && tm.primaryID == "" {
		tm.primaryID = id
	}

	return nil
}

// attach creates a PTY bridge to an existing tmux window (acquires lock).
func (tm *TmuxManager) attach(id string, win *TmuxWindow) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.attachLocked(id, win)
}

// attachLocked creates a PTY bridge to an existing tmux window (caller holds lock).
func (tm *TmuxManager) attachLocked(id string, win *TmuxWindow) error {
	// Build attach command
	target := fmt.Sprintf("%s:%d", tm.session, win.TmuxIndex)
	cmd := tmuxCmd("attach-session", "-t", target)

	// Start with creack/pty
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 120})
	if err != nil {
		return fmt.Errorf("failed to start tmux attach: %w", err)
	}

	inst := &attachedWindow{
		TmuxWindow: *win,
		ptmx:       ptmx,
		cmd:        cmd,
		listeners:  make(map[string]DataListener),
		disposed:   false,
	}

	tm.instances[id] = inst

	// Read goroutine: read PTY output, translate colors for neovim, dispatch to listeners
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])

				// Translate colon subparams to semicolons for neovim output
				if win.Role == RoleNeovim {
					data = colonCSIRe.ReplaceAllFunc(data, func(m []byte) []byte {
						last := len(m) - 1
						params := make([]byte, last)
						copy(params, m[1:last])
						for i, b := range params {
							if b == ':' {
								params[i] = ';'
							}
						}
						result := make([]byte, len(m))
						result[0] = 0x1b
						copy(result[1:last], params)
						result[last] = m[last]
						return result
					})
				}

				inst.listenerMu.Lock()
				for _, cb := range inst.listeners {
					cb(data)
				}
				inst.listenerMu.Unlock()
			}
			if err != nil {
				break
			}
		}
		// attach process ended — but tmux window may still be alive
		// This can happen if we called Detach or if the attach was killed
	}()

	return nil
}

// Write sends data to a tmux window's attached PTY.
func (tm *TmuxManager) Write(id string, data []byte) {
	tm.mu.RLock()
	inst, ok := tm.instances[id]
	tm.mu.RUnlock()
	if ok && !inst.disposed {
		inst.ptmx.Write(data)
	}
}

// Resize changes a tmux window's size.
func (tm *TmuxManager) Resize(id string, cols, rows uint16) {
	tm.mu.RLock()
	inst, ok := tm.instances[id]
	tm.mu.RUnlock()
	if !ok || inst.disposed || cols == 0 || rows == 0 {
		return
	}

	// Resize the creack/pty (for the attach process)
	pty.Setsize(inst.ptmx, &pty.Winsize{Rows: rows, Cols: cols})

	// Also tell tmux to resize the underlying window
	tmuxCmd("resize-window", "-t",
		fmt.Sprintf("%s:%d", tm.session, inst.TmuxIndex),
		"-x", strconv.Itoa(int(cols)),
		"-y", strconv.Itoa(int(rows))).Run()
}

// OnData subscribes to data events from a tmux window.
// Returns an unsubscribe function.
func (tm *TmuxManager) OnData(id string, cb DataListener) func() {
	tm.mu.RLock()
	inst, ok := tm.instances[id]
	tm.mu.RUnlock()
	if !ok {
		return func() {}
	}

	inst.listenerMu.Lock()
	listID := fmt.Sprintf("l%d", inst.nextListID)
	inst.nextListID++
	inst.listeners[listID] = cb
	inst.listenerMu.Unlock()

	return func() {
		inst.listenerMu.Lock()
		delete(inst.listeners, listID)
		inst.listenerMu.Unlock()
	}
}

// Kill destroys a tmux window and cleans up.
func (tm *TmuxManager) Kill(id string) {
	tm.mu.Lock()
	inst, ok := tm.instances[id]
	if !ok {
		tm.mu.Unlock()
		return
	}
	inst.disposed = true
	delete(tm.instances, id)

	// Promote next neovim if needed
	if tm.primaryID == id {
		tm.primaryID = ""
		for nextID, nextInst := range tm.instances {
			if nextInst.Role == RoleNeovim && !nextInst.disposed {
				tm.primaryID = nextID
				break
			}
		}
	}
	tm.mu.Unlock()

	// Close ptmx (kills the attach process, NOT the window process)
	inst.ptmx.Close()
	if inst.cmd.Process != nil {
		inst.cmd.Wait()
	}

	// Kill the actual tmux window
	tmuxCmd("kill-window", "-t",
		fmt.Sprintf("%s:%d", tm.session, inst.TmuxIndex)).Run()

	// Clean up nvim socket
	if inst.SocketPath != "" {
		os.Remove(inst.SocketPath)
	}

	// Clear listeners
	inst.listenerMu.Lock()
	for k := range inst.listeners {
		delete(inst.listeners, k)
	}
	inst.listenerMu.Unlock()
}

// Detach disconnects from a tmux window without killing it.
func (tm *TmuxManager) Detach(id string) {
	tm.mu.Lock()
	inst, ok := tm.instances[id]
	if !ok {
		tm.mu.Unlock()
		return
	}
	inst.disposed = true
	delete(tm.instances, id)

	// Update primary if needed
	if tm.primaryID == id {
		tm.primaryID = ""
		for nextID, nextInst := range tm.instances {
			if nextInst.Role == RoleNeovim && !nextInst.disposed {
				tm.primaryID = nextID
				break
			}
		}
	}
	tm.mu.Unlock()

	// Close ptmx (kills the attach process) but do NOT kill the tmux window
	inst.ptmx.Close()
	if inst.cmd.Process != nil {
		inst.cmd.Wait()
	}

	// Clear listeners
	inst.listenerMu.Lock()
	for k := range inst.listeners {
		delete(inst.listeners, k)
	}
	inst.listenerMu.Unlock()
}

// DetachAll disconnects from all windows without killing them.
// The tmux session stays alive for next server startup.
func (tm *TmuxManager) DetachAll() {
	tm.mu.Lock()
	ids := make([]string, 0, len(tm.instances))
	for id := range tm.instances {
		ids = append(ids, id)
	}
	tm.mu.Unlock()

	for _, id := range ids {
		tm.Detach(id)
	}
}

// ListWindows returns info about all attached tmux windows.
type WindowInfo struct {
	ID       string   `json:"id"`
	Role     PaneRole `json:"role"`
	Attached bool     `json:"attached"`
}

func (tm *TmuxManager) ListWindows() []WindowInfo {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	result := make([]WindowInfo, 0, len(tm.instances))
	for _, inst := range tm.instances {
		result = append(result, WindowInfo{
			ID:       inst.ID,
			Role:     inst.Role,
			Attached: !inst.disposed,
		})
	}
	return result
}

// CaptureScrollback captures the scrollback buffer of a tmux window.
func (tm *TmuxManager) CaptureScrollback(id string, lines int) ([]byte, error) {
	tm.mu.RLock()
	inst, ok := tm.instances[id]
	tm.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("instance %s not found", id)
	}

	target := fmt.Sprintf("%s:%d", tm.session, inst.TmuxIndex)
	cmd := tmuxCmd("capture-pane", "-t", target,
		"-p",
		"-S", fmt.Sprintf("-%d", lines),
		"-e") // -e preserves escape sequences (colors)

	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("capture-pane failed: %w", err)
	}

	// Trim trailing empty lines but keep content
	out = bytes.TrimRight(out, "\n")
	if len(out) > 0 {
		out = append(out, '\n')
	}

	return out, nil
}

// Has checks if an instance exists.
func (tm *TmuxManager) Has(id string) bool {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	_, ok := tm.instances[id]
	return ok
}

// GetRole returns the role of an instance.
func (tm *TmuxManager) GetRole(id string) (PaneRole, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	inst, ok := tm.instances[id]
	if !ok {
		return "", false
	}
	return inst.Role, true
}

// GetPrimarySocketPath returns the socket path of the primary (first editor) window.
func (tm *TmuxManager) GetPrimarySocketPath() string {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	if tm.primaryID == "" {
		return ""
	}
	inst, ok := tm.instances[tm.primaryID]
	if !ok {
		return ""
	}
	return inst.SocketPath
}

// GetPrimaryID returns the primary instance ID.
func (tm *TmuxManager) GetPrimaryID() string {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	return tm.primaryID
}

// GetNvimBin returns the configured nvim binary path.
func (tm *TmuxManager) GetNvimBin() string {
	tm.cfg.Mu.RLock()
	defer tm.cfg.Mu.RUnlock()
	return tm.cfg.Nvim.Bin
}

// NvimConfigInfo holds nvim configuration details for the API.
type NvimConfigInfo struct {
	Bin              string `json:"bin"`
	ConfigMode       string `json:"configMode"`
	ConfigDir        string `json:"configDir"`
	BundledConfigDir string `json:"bundledConfigDir"`
}

// GetNvimConfigInfo returns current nvim config info for the settings API.
func (tm *TmuxManager) GetNvimConfigInfo() NvimConfigInfo {
	tm.cfg.Mu.RLock()
	defer tm.cfg.Mu.RUnlock()
	return NvimConfigInfo{
		Bin:              tm.cfg.Nvim.Bin,
		ConfigMode:       string(tm.cfg.Nvim.ConfigMode),
		ConfigDir:        tm.cfg.Nvim.ConfigDir,
		BundledConfigDir: filepath.Join(tm.appDir, "nvim-config"),
	}
}

// ReloadConfig reloads the nvim section from a fresh config.
func (tm *TmuxManager) ReloadConfig(fresh *config.MineoCfg) {
	tm.cfg.Mu.Lock()
	defer tm.cfg.Mu.Unlock()
	if fresh != nil {
		tm.cfg.Nvim.Bin = fresh.Nvim.Bin
		tm.cfg.Nvim.ConfigMode = fresh.Nvim.ConfigMode
		tm.cfg.Nvim.ConfigDir = fresh.Nvim.ConfigDir
	}
}

// GetSocketPath returns the socket path for an instance.
func (tm *TmuxManager) GetSocketPath(id string) string {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	inst, ok := tm.instances[id]
	if !ok {
		return ""
	}
	return inst.SocketPath
}

// GetSessionName returns the tmux session name.
func (tm *TmuxManager) GetSessionName() string {
	return tm.session
}

// GetLayoutPath returns the path to the layout file.
func (tm *TmuxManager) GetLayoutPath() string {
	return tm.layoutPath
}

// SaveLayout writes layout JSON to disk.
func (tm *TmuxManager) SaveLayout(data []byte) error {
	return os.WriteFile(tm.layoutPath, data, 0644)
}

// LoadLayout reads layout JSON from disk.
func (tm *TmuxManager) LoadLayout() ([]byte, error) {
	return os.ReadFile(tm.layoutPath)
}
