package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// hiddenDirs are filtered from workspace file listings.
var hiddenDirs = map[string]bool{
	".git":        true,
	"node_modules": true,
	".DS_Store":    true,
	"__pycache__":  true,
	".next":        true,
	".nuxt":        true,
	"dist":         true,
}

// RegisterAPIRoutes registers all REST API endpoints.
func RegisterAPIRoutes(mux *http.ServeMux, cfg *MineoCfg, tmuxMgr *TmuxManager, configPath string, lspMgr *LspServerManager) {
	// ── GET /healthz ──────────────────────────────────────────────────
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// ── GET /api/workspace ────────────────────────────────────────────
	mux.HandleFunc("GET /api/workspace", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		ws := cfg.Workspace
		cfg.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]string{"workspace": ws})
	})

	// ── GET /api/browse?dir= ──────────────────────────────────────────
	mux.HandleFunc("GET /api/browse", func(w http.ResponseWriter, r *http.Request) {
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = homeDir()
		}
		if !filepath.IsAbs(dir) || strings.Contains(dir, "..") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid path"})
			return
		}
		resolved, err := filepath.Abs(dir)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid path"})
			return
		}

		entries, err := os.ReadDir(resolved)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		type dirEntry struct {
			Name string `json:"name"`
			Path string `json:"path"`
		}
		dirs := make([]dirEntry, 0)
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				dirs = append(dirs, dirEntry{
					Name: e.Name(),
					Path: filepath.Join(resolved, e.Name()),
				})
			}
		}
		sort.Slice(dirs, func(i, j int) bool {
			return dirs[i].Name < dirs[j].Name
		})

		var parent *string
		if resolved != "/" {
			p := filepath.Dir(resolved)
			parent = &p
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"dir":     resolved,
			"parent":  parent,
			"entries": dirs,
		})
	})

	// ── GET /api/files?dir= ───────────────────────────────────────────
	mux.HandleFunc("GET /api/files", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = workspace
		}
		if !filepath.IsAbs(dir) || strings.Contains(dir, "..") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid path"})
			return
		}
		resolved, _ := filepath.Abs(dir)
		if !strings.HasPrefix(resolved, workspace) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Path outside workspace"})
			return
		}

		entries, err := os.ReadDir(resolved)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		type fileEntry struct {
			Name        string  `json:"name"`
			Path        string  `json:"path"`
			IsDirectory bool    `json:"isDirectory"`
			Extension   *string `json:"extension,omitempty"`
		}
		result := make([]fileEntry, 0)
		for _, e := range entries {
			if hiddenDirs[e.Name()] {
				continue
			}
			fe := fileEntry{
				Name:        e.Name(),
				Path:        filepath.Join(resolved, e.Name()),
				IsDirectory: e.IsDir(),
			}
			if !e.IsDir() {
				ext := strings.TrimPrefix(filepath.Ext(e.Name()), ".")
				if ext != "" {
					fe.Extension = &ext
				}
			}
			result = append(result, fe)
		}
		// Sort: dirs first, then alphabetically
		sort.Slice(result, func(i, j int) bool {
			if result[i].IsDirectory != result[j].IsDirectory {
				return result[i].IsDirectory
			}
			return result[i].Name < result[j].Name
		})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"dir":     resolved,
			"entries": result,
		})
	})

	// ── POST /api/files/create ────────────────────────────────────────
	mux.HandleFunc("POST /api/files/create", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		var body struct {
			ParentDir   string `json:"parentDir"`
			Name        string `json:"name"`
			IsDirectory bool   `json:"isDirectory"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}
		if body.Name == "" || strings.Contains(body.Name, "/") || strings.Contains(body.Name, "..") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid name"})
			return
		}
		parent := validateWorkspacePath(body.ParentDir, workspace, w)
		if parent == "" {
			return
		}
		target := filepath.Join(parent, body.Name)
		if _, err := os.Stat(target); err == nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Already exists"})
			return
		}
		if body.IsDirectory {
			if err := os.MkdirAll(target, 0755); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		} else {
			if err := os.WriteFile(target, []byte(""), 0644); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "path": target})
	})

	// ── POST /api/files/rename ────────────────────────────────────────
	mux.HandleFunc("POST /api/files/rename", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		var body struct {
			OldPath string `json:"oldPath"`
			NewName string `json:"newName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}
		if body.NewName == "" || strings.Contains(body.NewName, "/") || strings.Contains(body.NewName, "..") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid name"})
			return
		}
		resolved := validateWorkspacePath(body.OldPath, workspace, w)
		if resolved == "" {
			return
		}
		newPath := filepath.Join(filepath.Dir(resolved), body.NewName)
		if !strings.HasPrefix(newPath, workspace) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Path outside workspace"})
			return
		}
		if _, err := os.Stat(resolved); os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
			return
		}
		if _, err := os.Stat(newPath); err == nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Target already exists"})
			return
		}
		if err := os.Rename(resolved, newPath); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "path": newPath})
	})

	// ── POST /api/files/delete ────────────────────────────────────────
	mux.HandleFunc("POST /api/files/delete", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		var body struct {
			TargetPath string `json:"targetPath"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}
		resolved := validateWorkspacePath(body.TargetPath, workspace, w)
		if resolved == "" {
			return
		}
		if resolved == workspace {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cannot delete workspace root"})
			return
		}
		if _, err := os.Stat(resolved); os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
			return
		}
		if err := os.RemoveAll(resolved); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── GET /api/files/download?path= ────────────────────────────────
	mux.HandleFunc("GET /api/files/download", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		p := r.URL.Query().Get("path")
		resolved := validateWorkspacePath(p, workspace, w)
		if resolved == "" {
			return
		}
		info, err := os.Stat(resolved)
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
			return
		}
		if info.IsDir() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Cannot download a directory"})
			return
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(resolved)))
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, resolved)
	})

	// ── POST /api/files/upload?dir= ───────────────────────────────────
	mux.HandleFunc("POST /api/files/upload", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		dir := r.URL.Query().Get("dir")
		destDir := validateWorkspacePath(dir, workspace, w)
		if destDir == "" {
			return
		}

		// Limit upload size to 256 MB
		if err := r.ParseMultipartForm(256 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Failed to parse upload"})
			return
		}

		files := r.MultipartForm.File["files"]
		if len(files) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "No files provided"})
			return
		}

		type uploadResult struct {
			Name  string `json:"name"`
			Error string `json:"error,omitempty"`
		}
		results := make([]uploadResult, 0, len(files))

		for _, fh := range files {
			name := filepath.Base(fh.Filename)
			if name == "" || strings.Contains(name, "..") || strings.ContainsRune(name, '/') {
				results = append(results, uploadResult{Name: fh.Filename, Error: "Invalid filename"})
				continue
			}
			dest := filepath.Join(destDir, name)
			if !strings.HasPrefix(dest, workspace) {
				results = append(results, uploadResult{Name: name, Error: "Path outside workspace"})
				continue
			}
			src, err := fh.Open()
			if err != nil {
				results = append(results, uploadResult{Name: name, Error: err.Error()})
				continue
			}
			data := make([]byte, fh.Size)
			_, err = src.Read(data)
			src.Close()
			if err != nil && err.Error() != "EOF" {
				results = append(results, uploadResult{Name: name, Error: err.Error()})
				continue
			}
			if err := os.WriteFile(dest, data, 0644); err != nil {
				results = append(results, uploadResult{Name: name, Error: err.Error()})
				continue
			}
			results = append(results, uploadResult{Name: name})
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "results": results})
	})

	// ── GET /api/config ───────────────────────────────────────────────
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		ws := cfg.Workspace
		pw := cfg.Password
		cfg.mu.RUnlock()

		pwDisplay := ""
		if pw != "" {
			pwDisplay = "••••••••"
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"workspace":   ws,
			"hasPassword": pw != "",
			"password":    pwDisplay,
		})
	})

	// ── POST /api/config ──────────────────────────────────────────────
	mux.HandleFunc("POST /api/config", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}

		patch := make(map[string]interface{})

		if ws, ok := body["workspace"]; ok {
			wsStr, isStr := ws.(string)
			if !isStr || strings.TrimSpace(wsStr) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workspace must be a non-empty string"})
				return
			}
			patch["workspace"] = strings.TrimSpace(wsStr)
		}

		if pw, ok := body["password"]; ok {
			pwStr, isStr := pw.(string)
			if !isStr {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be a string"})
				return
			}
			patch["password"] = pwStr
		}

		if err := SaveConfig(configPath, patch); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		// Hot-reload
		cfg.mu.Lock()
		if ws, ok := patch["workspace"].(string); ok {
			cfg.Workspace = ws
		}
		if pw, ok := patch["password"].(string); ok {
			cfg.Password = pw
		}
		cfg.mu.Unlock()

		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── GET /api/git/status ───────────────────────────────────────────
	mux.HandleFunc("GET /api/git/status", func(w http.ResponseWriter, r *http.Request) {
		cfg.mu.RLock()
		workspace := cfg.Workspace
		cfg.mu.RUnlock()

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		// Check if this is a git repo
		if err := exec.CommandContext(ctx, "git", "-C", workspace, "rev-parse", "--is-inside-work-tree").Run(); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"is_repo": false})
			return
		}

		branchOut, _ := exec.CommandContext(ctx, "git", "-C", workspace, "branch", "--show-current").Output()
		branch := strings.TrimSpace(string(branchOut))

		statusOut, err := exec.CommandContext(ctx, "git", "-C", workspace, "status", "--porcelain=v1", "-u").Output()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "git status failed"})
			return
		}

		type gitFile struct {
			Path   string `json:"path"`
			Status string `json:"status"`
		}
		var files []gitFile
		for _, line := range strings.Split(string(statusOut), "\n") {
			if len(line) < 4 {
				continue
			}
			xy := strings.TrimSpace(line[:2])
			fp := strings.TrimSpace(line[3:])
			if strings.Contains(fp, " -> ") {
				parts := strings.SplitN(fp, " -> ", 2)
				fp = parts[1]
			}
			files = append(files, gitFile{Path: fp, Status: xy})
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"is_repo": true,
			"branch":  branch,
			"files":   files,
		})
	})

	// ── GET /api/nvim-ready ───────────────────────────────────────────
	mux.HandleFunc("GET /api/nvim-ready", func(w http.ResponseWriter, r *http.Request) {
		sockPath := tmuxMgr.GetPrimarySocketPath()
		if sockPath == "" {
			writeJSON(w, http.StatusOK, map[string]bool{"ready": false})
			return
		}
		ready := CheckNvimReady(sockPath, 500)
		writeJSON(w, http.StatusOK, map[string]bool{"ready": ready})
	})

	// ── GET /api/metrics ──────────────────────────────────────────────
	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		appMB := int(math.Round(float64(m.Sys) / 1024 / 1024))

		// Get total system memory
		totalGB := getTotalMemGB()
		writeJSON(w, http.StatusOK, map[string]int{"appMB": appMB, "totalGB": totalGB})
	})

	// ── GET /api/nvim-open?file=&instanceId= ─────────────────────────
	mux.HandleFunc("GET /api/nvim-open", func(w http.ResponseWriter, r *http.Request) {
		file := r.URL.Query().Get("file")
		if file == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing file param"})
			return
		}
		if !filepath.IsAbs(file) || strings.Contains(file, "..") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid path"})
			return
		}

		instanceID := r.URL.Query().Get("instanceId")

		const retryMs = 500
		const maxAttempts = 20 // up to 10 seconds

		var lastErr error
		for i := 0; i < maxAttempts; i++ {
			var sockPath string
			if instanceID != "" {
				sockPath = tmuxMgr.GetSocketPath(instanceID)
			} else {
				sockPath = tmuxMgr.GetPrimarySocketPath()
			}
			if sockPath == "" {
				if i < maxAttempts-1 {
					time.Sleep(retryMs * time.Millisecond)
				}
				continue
			}

			// Wait until nvim's RPC socket is actually accepting connections
			ready := CheckNvimReady(sockPath, 400)
			if !ready {
				if i < maxAttempts-1 {
					time.Sleep(retryMs * time.Millisecond)
				}
				continue
			}

			nvimBin := tmuxMgr.GetNvimBin()
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			// Use --remote-send with :e to open silently (--remote-silent can show
			// "Press ENTER" prompts when nvim is busy or the file is already open)
			fileDir := filepath.Dir(file)
			cmd := exec.CommandContext(ctx, nvimBin, "--server", sockPath, "--remote-send",
				fmt.Sprintf("<Esc>:e %s<CR>:cd %s<CR>", file, fileDir))
			err := cmd.Run()
			cancel()

			if err != nil {
				lastErr = err
				if i < maxAttempts-1 {
					time.Sleep(retryMs * time.Millisecond)
				}
				continue
			}

			writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
			return
		}

		detail := ""
		if lastErr != nil {
			detail = lastErr.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error":  "Neovim not running after 10s",
			"detail": detail,
		})
	})

	// ── GET /api/nvim-config ──────────────────────────────────────────
	mux.HandleFunc("GET /api/nvim-config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, tmuxMgr.GetNvimConfigInfo())
	})

	// ── POST /api/nvim-config ─────────────────────────────────────────
	mux.HandleFunc("POST /api/nvim-config", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}

		patch := make(map[string]interface{})

		if bin, ok := body["bin"]; ok {
			binStr, isStr := bin.(string)
			if !isStr || binStr == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bin must be a non-empty string"})
				return
			}
			patch["bin"] = binStr
		}

		if mode, ok := body["configMode"]; ok {
			modeStr, isStr := mode.(string)
			if !isStr || (modeStr != "system" && modeStr != "bundled" && modeStr != "custom") {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "configMode must be system|bundled|custom"})
				return
			}
			patch["configMode"] = modeStr
		}

		if dir, ok := body["configDir"]; ok {
			dirStr, isStr := dir.(string)
			if !isStr {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "configDir must be a string"})
				return
			}
			patch["configDir"] = dirStr
		}

		if err := SaveNvimConfig(configPath, patch); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		freshCfg := LoadConfig(configPath)
		tmuxMgr.ReloadConfig(freshCfg)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":     true,
			"config": tmuxMgr.GetNvimConfigInfo(),
		})
	})

	// ── GET /api/nvim-config-dir ──────────────────────────────────────
	mux.HandleFunc("GET /api/nvim-config-dir", func(w http.ResponseWriter, r *http.Request) {
		info := tmuxMgr.GetNvimConfigInfo()
		var configDir string
		switch info.ConfigMode {
		case "bundled":
			configDir = info.BundledConfigDir
		case "custom":
			if info.ConfigDir != "" {
				configDir = info.ConfigDir
			} else {
				configDir = filepath.Join(homeDir(), ".config", "nvim")
			}
		default: // system
			configDir = filepath.Join(homeDir(), ".config", "nvim")
		}
		writeJSON(w, http.StatusOK, map[string]string{"configDir": configDir})
	})

	// ── GET /api/lsp/status ───────────────────────────────────────────
	mux.HandleFunc("GET /api/lsp/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, lspMgr.StatusAll())
	})

	// ── POST /api/lsp/stop ────────────────────────────────────────────
	mux.HandleFunc("POST /api/lsp/stop", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Lang string `json:"lang"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Lang == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing lang"})
			return
		}
		if _, ok := LSP_SERVERS[body.Lang]; !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown language"})
			return
		}
		stopped := lspMgr.StopLang(body.Lang)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "was_running": stopped})
	})

	// ── GET /api/session/windows ─────────────────────────────────────
	mux.HandleFunc("GET /api/session/windows", func(w http.ResponseWriter, r *http.Request) {
		windows := tmuxMgr.ListWindows()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"session": tmuxMgr.GetSessionName(),
			"windows": windows,
		})
	})

	// ── GET /api/session/layout ──────────────────────────────────────
	mux.HandleFunc("GET /api/session/layout", func(w http.ResponseWriter, r *http.Request) {
		data, err := tmuxMgr.LoadLayout()
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"layout": nil})
			return
		}
		var layout interface{}
		if err := json.Unmarshal(data, &layout); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"layout": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"layout": layout})
	})

	// ── POST /api/session/layout ─────────────────────────────────────
	mux.HandleFunc("POST /api/session/layout", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Layout interface{} `json:"layout"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
			return
		}
		data, err := json.Marshal(body.Layout)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to marshal layout"})
			return
		}
		if err := tmuxMgr.SaveLayout(data); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})
}

// validateWorkspacePath checks that a path is absolute, has no "..", and is within the workspace.
// Returns the resolved absolute path, or empty string (with error written to w).
func validateWorkspacePath(p string, workspace string, w http.ResponseWriter) string {
	if p == "" || !filepath.IsAbs(p) || strings.Contains(p, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid path"})
		return ""
	}
	resolved, _ := filepath.Abs(p)
	if !strings.HasPrefix(resolved, workspace) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Path outside workspace"})
		return ""
	}
	return resolved
}

// ValidateStartup checks startup preconditions and exits fatally if they fail.
func ValidateStartup(cfg *MineoCfg) {
	if _, err := os.Stat(cfg.Workspace); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr,
			"Error: Workspace not found: %q. Create it or update workspace in config.json.\n",
			cfg.Workspace)
		os.Exit(1)
	}

	nvimBin := cfg.Nvim.Bin
	if _, err := exec.LookPath(nvimBin); err != nil {
		// Also try running it directly
		cmd := exec.Command(nvimBin, "--version")
		if cmd.Run() != nil {
			fmt.Fprintf(os.Stderr,
				"Error: nvim not found at %q. Install Neovim or fix nvim.bin in config.json.\n",
				nvimBin)
			os.Exit(1)
		}
	}
}

// writeJSON is a helper to send JSON responses.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// getTotalMemGB returns the total system memory in GB.
func getTotalMemGB() int {
	// Use sysctl on macOS, /proc/meminfo on Linux
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
		if err == nil {
			s := strings.TrimSpace(string(out))
			if bytes, err := fmt.Sscanf(s, "%d"); err == nil && bytes > 0 {
				var memBytes int64
				fmt.Sscanf(s, "%d", &memBytes)
				return int(math.Round(float64(memBytes) / 1024 / 1024 / 1024))
			}
		}
	case "linux":
		data, err := os.ReadFile("/proc/meminfo")
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "MemTotal:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 {
						var kb int64
						fmt.Sscanf(fields[1], "%d", &kb)
						return int(math.Round(float64(kb) / 1024 / 1024))
					}
				}
			}
		}
	}
	return 0
}
