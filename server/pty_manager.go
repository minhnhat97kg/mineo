package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/creack/pty"
)

// PaneRole describes the kind of PTY instance.
type PaneRole string

const (
	RoleNeovim   PaneRole = "neovim"
	RoleTerminal PaneRole = "terminal"
)

// DataListener receives PTY output as raw bytes.
type DataListener func(data []byte)

// PtyInstance represents a single running PTY process.
type PtyInstance struct {
	ptmx       *os.File
	cmd        *exec.Cmd
	role       PaneRole
	socketPath string // only for neovim PTYs
	listeners  map[string]DataListener
	listenerMu sync.Mutex
	disposed   bool
	nextListID int
}

// PtyManager manages a collection of PTY instances.
type PtyManager struct {
	mu        sync.RWMutex
	instances map[string]*PtyInstance
	primaryID string
	cfg       *MineoCfg
	appDir    string // directory of the running binary (for bundled config)
}

// NewPtyManager creates a new PTY manager.
func NewPtyManager(cfg *MineoCfg, appDir string) *PtyManager {
	return &PtyManager{
		instances: make(map[string]*PtyInstance),
		cfg:       cfg,
		appDir:    appDir,
	}
}

// colonCSIRe matches any CSI sequence that contains colon-separated subparams.
// xterm.js only understands semicolons as param separators; colons cause parse errors.
// Pattern: ESC [ <params-with-colons> <final-byte>
// We replace every colon inside the param area with a semicolon.
var colonCSIRe = regexp.MustCompile(`\x1b\[([0-9:;]*)([A-Za-z])`)

// nvimConfigEnv returns extra env vars based on the configured nvim config mode.
func (pm *PtyManager) nvimConfigEnv() []string {
	pm.cfg.mu.RLock()
	mode := pm.cfg.Nvim.ConfigMode
	configDir := pm.cfg.Nvim.ConfigDir
	pm.cfg.mu.RUnlock()

	bundledConfigDir := filepath.Join(pm.appDir, "nvim-config")

	switch mode {
	case NvimConfigBundled:
		return []string{"XDG_CONFIG_HOME=" + bundledConfigDir}
	case NvimConfigCustom:
		if configDir != "" {
			return []string{"XDG_CONFIG_HOME=" + configDir}
		}
	}
	// system mode: no XDG_CONFIG_HOME override — nvim uses ~/.config/nvim
	return nil
}

// filterEnv removes a key from an env slice (used to strip inherited XDG_CONFIG_HOME).
func filterEnv(env []string, key string) []string {
	prefix := key + "="
	out := env[:0]
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return out
}

// Spawn creates a new PTY instance.
func (pm *PtyManager) Spawn(id string, role PaneRole, cols, rows uint16, cwd string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if _, exists := pm.instances[id]; exists {
		return fmt.Errorf("PTY instance %s already exists", id)
	}

	// Resolve cwd: use provided if valid absolute path that exists, else workspace
	resolvedCwd := pm.cfg.Workspace
	if cwd != "" && filepath.IsAbs(cwd) {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			resolvedCwd = cwd
		}
	}

	// Base environment — ensure HOME is always set
	env := os.Environ()
	env = append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
	if os.Getenv("HOME") == "" {
		env = append(env, "HOME="+homeDir())
	}

	var cmd *exec.Cmd
	var socketPath string

	pm.cfg.mu.RLock()
	nvimBin := pm.cfg.Nvim.Bin
	pm.cfg.mu.RUnlock()

	if role == RoleNeovim {
		socketPath = fmt.Sprintf("/tmp/mineo-nvim-%s.sock", id)
		// Remove stale socket
		os.Remove(socketPath)

		cmd = exec.Command(nvimBin, "--listen", socketPath, "-c", "set mouse=a")
		cmd.Dir = resolvedCwd

		// Apply nvim config env — strip any inherited XDG_CONFIG_HOME first
		// so system mode uses ~/.config/nvim cleanly
		env = filterEnv(env, "XDG_CONFIG_HOME")
		extraEnv := pm.nvimConfigEnv()
		env = append(env, extraEnv...)
		cmd.Env = env
	} else {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/bash"
		}
		cmd = exec.Command(shell)
		cmd.Dir = resolvedCwd
		cmd.Env = env
	}

	// Start the PTY
	winSize := &pty.Winsize{Rows: rows, Cols: cols}
	ptmx, err := pty.StartWithSize(cmd, winSize)
	if err != nil {
		return fmt.Errorf("failed to start PTY: %w", err)
	}

	inst := &PtyInstance{
		ptmx:       ptmx,
		cmd:        cmd,
		role:       role,
		socketPath: socketPath,
		listeners:  make(map[string]DataListener),
		disposed:   false,
	}

	// Track first editor as primary
	if role == RoleNeovim && pm.primaryID == "" {
		pm.primaryID = id
	}

	pm.instances[id] = inst

	// Read goroutine: read PTY output, translate colors for neovim, dispatch to listeners
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])

				// Translate colon subparams to semicolons for neovim output.
				// Neovim emits ISO 8613-6 colon-separated SGR (e.g. \x1b[38:2:R:G:Bm)
				// which xterm.js cannot parse — it only understands semicolons.
				if role == RoleNeovim {
					data = colonCSIRe.ReplaceAllFunc(data, func(m []byte) []byte {
						// Only replace colons in the param region (before the final letter)
						last := len(m) - 1
						params := make([]byte, last)
						copy(params, m[1:last]) // strip leading ESC[
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
		// Process exited — clean up
		pm.cleanup(id)
	}()

	return nil
}

// Write sends data to a PTY's stdin.
func (pm *PtyManager) Write(id string, data []byte) {
	pm.mu.RLock()
	inst, ok := pm.instances[id]
	pm.mu.RUnlock()
	if ok && !inst.disposed {
		inst.ptmx.Write(data)
	}
}

// Resize changes a PTY's window size.
func (pm *PtyManager) Resize(id string, cols, rows uint16) {
	pm.mu.RLock()
	inst, ok := pm.instances[id]
	pm.mu.RUnlock()
	if ok && !inst.disposed && cols > 0 && rows > 0 {
		pty.Setsize(inst.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
	}
}

// OnData subscribes to data events from a PTY.
// Returns an unsubscribe function.
func (pm *PtyManager) OnData(id string, cb DataListener) func() {
	pm.mu.RLock()
	inst, ok := pm.instances[id]
	pm.mu.RUnlock()
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

// Kill terminates a PTY instance.
func (pm *PtyManager) Kill(id string) {
	pm.mu.Lock()
	inst, ok := pm.instances[id]
	if !ok {
		pm.mu.Unlock()
		return
	}
	inst.disposed = true
	pm.mu.Unlock()

	inst.ptmx.Close()
	if inst.cmd.Process != nil {
		inst.cmd.Process.Kill()
	}
	pm.cleanup(id)
}

// Has checks if an instance exists.
func (pm *PtyManager) Has(id string) bool {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	_, ok := pm.instances[id]
	return ok
}

// GetRole returns the role of an instance.
func (pm *PtyManager) GetRole(id string) (PaneRole, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	inst, ok := pm.instances[id]
	if !ok {
		return "", false
	}
	return inst.role, true
}

// GetPrimarySocketPath returns the socket path of the primary (first editor) PTY.
func (pm *PtyManager) GetPrimarySocketPath() string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	if pm.primaryID == "" {
		return ""
	}
	inst, ok := pm.instances[pm.primaryID]
	if !ok {
		return ""
	}
	return inst.socketPath
}

// GetPrimaryID returns the primary instance ID.
func (pm *PtyManager) GetPrimaryID() string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return pm.primaryID
}

// GetNvimBin returns the configured nvim binary path.
func (pm *PtyManager) GetNvimBin() string {
	pm.cfg.mu.RLock()
	defer pm.cfg.mu.RUnlock()
	return pm.cfg.Nvim.Bin
}

// NvimConfigInfo holds nvim configuration details for the API.
type NvimConfigInfo struct {
	Bin              string `json:"bin"`
	ConfigMode       string `json:"configMode"`
	ConfigDir        string `json:"configDir"`
	BundledConfigDir string `json:"bundledConfigDir"`
}

// GetNvimConfigInfo returns current nvim config info for the settings API.
func (pm *PtyManager) GetNvimConfigInfo() NvimConfigInfo {
	pm.cfg.mu.RLock()
	defer pm.cfg.mu.RUnlock()
	return NvimConfigInfo{
		Bin:              pm.cfg.Nvim.Bin,
		ConfigMode:       string(pm.cfg.Nvim.ConfigMode),
		ConfigDir:        pm.cfg.Nvim.ConfigDir,
		BundledConfigDir: filepath.Join(pm.appDir, "nvim-config"),
	}
}

// ReloadConfig reloads the nvim section from a fresh config.
func (pm *PtyManager) ReloadConfig(fresh *MineoCfg) {
	pm.cfg.mu.Lock()
	defer pm.cfg.mu.Unlock()
	if fresh != nil {
		pm.cfg.Nvim.Bin = fresh.Nvim.Bin
		pm.cfg.Nvim.ConfigMode = fresh.Nvim.ConfigMode
		pm.cfg.Nvim.ConfigDir = fresh.Nvim.ConfigDir
	}
}

// GetSocketPath returns the socket path for an instance.
func (pm *PtyManager) GetSocketPath(id string) string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	inst, ok := pm.instances[id]
	if !ok {
		return ""
	}
	return inst.socketPath
}

// DisposeAll kills all PTY instances.
func (pm *PtyManager) DisposeAll() {
	pm.mu.RLock()
	ids := make([]string, 0, len(pm.instances))
	for id := range pm.instances {
		ids = append(ids, id)
	}
	pm.mu.RUnlock()

	for _, id := range ids {
		pm.Kill(id)
	}
}

// cleanup removes a PTY from the map and handles primary promotion.
func (pm *PtyManager) cleanup(id string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	inst, ok := pm.instances[id]
	if !ok {
		return
	}

	inst.disposed = true
	inst.listenerMu.Lock()
	// Clear all listeners
	for k := range inst.listeners {
		delete(inst.listeners, k)
	}
	inst.listenerMu.Unlock()

	// Clean up socket file for editor PTYs
	if inst.socketPath != "" {
		os.Remove(inst.socketPath)
	}

	// Close ptmx (ignore errors — may already be closed)
	inst.ptmx.Close()

	// Wait for process to finish (non-blocking best effort)
	go func() {
		if inst.cmd.Process != nil {
			inst.cmd.Wait()
		}
	}()

	delete(pm.instances, id)

	// If primary was killed, promote next editor
	if pm.primaryID == id {
		pm.primaryID = ""
		for nextID, nextInst := range pm.instances {
			if nextInst.role == RoleNeovim && !nextInst.disposed {
				pm.primaryID = nextID
				break
			}
		}
	}
}
