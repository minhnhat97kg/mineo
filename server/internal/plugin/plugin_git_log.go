package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"mineo/server/internal/config"
)

func init() {
	RegisterPlugin(&GitLogPlugin{})
}

type GitLogPlugin struct{}

func (g *GitLogPlugin) Name() string { return "git-log" }

func (g *GitLogPlugin) Register(mux *http.ServeMux, cfg *config.MineoCfg) {
	// ── GET /api/plugin/git-log/commits ──────────────────────────────
	// Returns the last 200 commits with hash, short hash, subject, author,
	// ISO date, and ref decorations (branches/tags).
	mux.HandleFunc("GET /api/plugin/git-log/commits", func(w http.ResponseWriter, r *http.Request) {
		cfg.Mu.RLock()
		workspace := cfg.Workspace
		cfg.Mu.RUnlock()

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// Check it's a git repo
		if err := exec.CommandContext(ctx, "git", "-C", workspace,
			"rev-parse", "--is-inside-work-tree").Run(); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"is_repo": false,
				"commits": []struct{}{},
			})
			return
		}

		// --decorate=full gives us full ref names; format is tab-separated
		// fields: hash \t shorthash \t author \t date(ISO) \t refs \t subject
		const format = "%H\t%h\t%an\t%aI\t%D\t%s"
		out, err := exec.CommandContext(ctx, "git", "-C", workspace,
			"log", "--pretty=format:"+format, "-200",
		).Output()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError,
				map[string]string{"error": "git log failed: " + err.Error()})
			return
		}

		type Commit struct {
			Hash    string   `json:"hash"`
			Short   string   `json:"short"`
			Author  string   `json:"author"`
			Date    string   `json:"date"`
			Refs    []string `json:"refs"`
			Subject string   `json:"subject"`
		}

		lines := strings.Split(string(out), "\n")
		commits := make([]Commit, 0, len(lines))
		for _, line := range lines {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 6)
			if len(parts) < 6 {
				continue
			}
			refs := []string{}
			if parts[4] != "" {
				for _, r := range strings.Split(parts[4], ", ") {
					r = strings.TrimSpace(r)
					if r != "" {
						refs = append(refs, r)
					}
				}
			}
			commits = append(commits, Commit{
				Hash:    parts[0],
				Short:   parts[1],
				Author:  parts[2],
				Date:    parts[3],
				Refs:    refs,
				Subject: parts[5],
			})
		}

		// Also get current branch name
		branchOut, _ := exec.CommandContext(ctx, "git", "-C", workspace,
			"branch", "--show-current").Output()
		branch := strings.TrimSpace(string(branchOut))

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"is_repo": true,
			"branch":  branch,
			"commits": commits,
		})
	})

	// ── GET /api/plugin/git-log/diff?hash= ───────────────────────────
	// Returns the full diff (git show) for a given commit hash.
	mux.HandleFunc("GET /api/plugin/git-log/diff", func(w http.ResponseWriter, r *http.Request) {
		cfg.Mu.RLock()
		workspace := cfg.Workspace
		cfg.Mu.RUnlock()

		hash := r.URL.Query().Get("hash")
		if hash == "" || strings.ContainsAny(hash, " \t\n;|&`$(){}") {
			writeJSON(w, http.StatusBadRequest,
				map[string]string{"error": "invalid hash"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		out, err := exec.CommandContext(ctx, "git", "-C", workspace,
			"show", "--stat", "--patch", hash,
		).Output()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError,
				map[string]string{"error": "git show failed: " + err.Error()})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"diff": string(out),
		})
	})

	// ── GET /api/plugin/git-log/branches ─────────────────────────────
	// Returns all local + remote branches.
	mux.HandleFunc("GET /api/plugin/git-log/branches", func(w http.ResponseWriter, r *http.Request) {
		cfg.Mu.RLock()
		workspace := cfg.Workspace
		cfg.Mu.RUnlock()

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		out, err := exec.CommandContext(ctx, "git", "-C", workspace,
			"branch", "-a", "--format=%(refname:short)").Output()
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"branches": []string{}})
			return
		}

		branches := []string{}
		for _, b := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if b = strings.TrimSpace(b); b != "" {
				branches = append(branches, b)
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"branches": branches})
	})

	// ── POST /api/plugin/git-log/checkout ────────────────────────────
	// Checks out a branch by name.
	mux.HandleFunc("POST /api/plugin/git-log/checkout", func(w http.ResponseWriter, r *http.Request) {
		cfg.Mu.RLock()
		workspace := cfg.Workspace
		cfg.Mu.RUnlock()

		var body struct {
			Branch string `json:"branch"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Branch == "" {
			writeJSON(w, http.StatusBadRequest,
				map[string]string{"error": "missing branch"})
			return
		}
		if strings.ContainsAny(body.Branch, " \t\n;|&`$(){}") {
			writeJSON(w, http.StatusBadRequest,
				map[string]string{"error": "invalid branch name"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		out, err := exec.CommandContext(ctx, "git", "-C", workspace,
			"checkout", body.Branch).CombinedOutput()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": strings.TrimSpace(string(out)),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})
}
