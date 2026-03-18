package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
)

// NvimConfigMode controls how neovim resolves its config directory.
type NvimConfigMode string

const (
	NvimConfigSystem  NvimConfigMode = "system"
	NvimConfigBundled NvimConfigMode = "bundled"
	NvimConfigCustom  NvimConfigMode = "custom"
)

// UISettings holds user interface preferences persisted server-side.
type UISettings struct {
	FontFamily string `json:"fontFamily"`
	FontSize   int    `json:"fontSize"`
	Theme      string `json:"theme"`
}

// MineoCfg holds the application configuration.
type MineoCfg struct {
	Port      int    `json:"port"`
	Workspace string `json:"workspace"`
	Password  string `json:"password"`
	Nvim      struct {
		Bin        string         `json:"bin"`
		ConfigMode NvimConfigMode `json:"configMode"`
		ConfigDir  string         `json:"configDir"`
	} `json:"nvim"`
	UI UISettings `json:"ui"`

	// Secret is the hex session secret loaded from .secret at startup.
	// It is never written to config.json (json:"-").
	Secret string `json:"-"`

	Mu sync.RWMutex // protects hot-reload of workspace/password
}

// defaults returns a MineoCfg with sensible defaults.
// Workspace defaults to the current working directory.
func defaults() *MineoCfg {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = HomeDir()
	}
	cfg := &MineoCfg{
		Port:      3000,
		Workspace: cwd,
		Password:  "",
	}
	cfg.Nvim.Bin = "nvim"
	cfg.Nvim.ConfigMode = NvimConfigSystem
	cfg.Nvim.ConfigDir = ""
	cfg.UI.FontFamily = `"JetBrainsMono Nerd Font", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace`
	cfg.UI.FontSize = 13
	cfg.UI.Theme = "mineo-dark"
	return cfg
}

func HomeDir() string {
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	return "/"
}

func expandTilde(p string) string {
	if strings.HasPrefix(p, "~/") || p == "~" {
		return filepath.Join(HomeDir(), p[1:])
	}
	return p
}

// LoadConfig reads and parses config.json with defaults and tilde expansion.
func LoadConfig(configPath string) *MineoCfg {
	cfg := defaults()

	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "[config] config.json not found, using defaults\n")
		} else {
			fmt.Fprintf(os.Stderr, "[config] Failed to read config.json: %v\n", err)
		}
		return cfg
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		fmt.Fprintf(os.Stderr, "[config] Failed to parse config.json: %v\n", err)
		return cfg
	}

	if v, ok := raw["port"]; ok {
		var port int
		if err := json.Unmarshal(v, &port); err != nil {
			fmt.Fprintf(os.Stderr, "[config] port must be a number, using default 3000\n")
		} else {
			cfg.Port = port
		}
	}

	if v, ok := raw["workspace"]; ok {
		var ws string
		if err := json.Unmarshal(v, &ws); err != nil {
			fmt.Fprintf(os.Stderr, "[config] workspace must be a string, using default\n")
		} else {
			cfg.Workspace = expandTilde(ws)
		}
	}

	if v, ok := raw["password"]; ok {
		var pw string
		if err := json.Unmarshal(v, &pw); err != nil {
			fmt.Fprintf(os.Stderr, "[config] password must be a string, using default\n")
		} else {
			cfg.Password = pw
		}
	}

	if v, ok := raw["ui"]; ok {
		var ui UISettings
		if err := json.Unmarshal(v, &ui); err == nil {
			if ui.FontFamily != "" {
				cfg.UI.FontFamily = ui.FontFamily
			}
			if ui.FontSize > 0 {
				cfg.UI.FontSize = ui.FontSize
			}
			if ui.Theme != "" {
				cfg.UI.Theme = ui.Theme
			}
		}
	}

	if v, ok := raw["nvim"]; ok {
		var nvimRaw map[string]json.RawMessage
		if err := json.Unmarshal(v, &nvimRaw); err == nil {
			if b, ok := nvimRaw["bin"]; ok {
				var bin string
				if err := json.Unmarshal(b, &bin); err != nil {
					fmt.Fprintf(os.Stderr, "[config] nvim.bin must be a string, using default\n")
				} else {
					cfg.Nvim.Bin = expandTilde(bin)
				}
			}
			if m, ok := nvimRaw["configMode"]; ok {
				var mode string
				if err := json.Unmarshal(m, &mode); err == nil {
					switch NvimConfigMode(mode) {
					case NvimConfigSystem, NvimConfigBundled, NvimConfigCustom:
						cfg.Nvim.ConfigMode = NvimConfigMode(mode)
					default:
						fmt.Fprintf(os.Stderr, "[config] nvim.configMode must be system|bundled|custom, using system\n")
					}
				}
			}
			if d, ok := nvimRaw["configDir"]; ok {
				var dir string
				if err := json.Unmarshal(d, &dir); err != nil {
					fmt.Fprintf(os.Stderr, "[config] nvim.configDir must be a string\n")
				} else {
					cfg.Nvim.ConfigDir = expandTilde(dir)
				}
			}
		}
	}

	return cfg
}

// SaveConfig persists top-level fields (workspace, password) back to config.json.
func SaveConfig(configPath string, patch map[string]interface{}) error {
	raw := loadRawJSON(configPath)

	if ws, ok := patch["workspace"]; ok {
		raw["workspace"] = ws
	}
	if pw, ok := patch["password"]; ok {
		raw["password"] = pw
	}

	return writeConfigJSON(configPath, raw)
}

// SaveUISettings persists the ui section of config back to config.json.
func SaveUISettings(configPath string, ui UISettings) error {
	raw := loadRawJSON(configPath)
	raw["ui"] = ui
	return writeConfigJSON(configPath, raw)
}

// SaveNvimConfig persists the nvim section of config back to config.json.
func SaveNvimConfig(configPath string, nvimPatch map[string]interface{}) error {
	raw := loadRawJSON(configPath)

	existing, _ := raw["nvim"].(map[string]interface{})
	if existing == nil {
		existing = make(map[string]interface{})
	}
	for k, v := range nvimPatch {
		existing[k] = v
	}
	raw["nvim"] = existing

	return writeConfigJSON(configPath, raw)
}

// loadRawJSON reads existing config.json as a generic map, or returns empty map.
func loadRawJSON(configPath string) map[string]interface{} {
	raw := make(map[string]interface{})
	data, err := os.ReadFile(configPath)
	if err != nil {
		return raw
	}
	_ = json.Unmarshal(data, &raw)
	return raw
}

func writeConfigJSON(configPath string, data map[string]interface{}) error {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(configPath, out, 0644)
}

// LoadOrCreateSecret reads a hex secret from disk, or creates one with crypto/rand.
func LoadOrCreateSecret(secretPath string) (string, error) {
	data, err := os.ReadFile(secretPath)
	if err == nil {
		return strings.TrimSpace(string(data)), nil
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("crypto/rand failed: %w", err)
	}
	secret := hex.EncodeToString(buf)

	if err := os.WriteFile(secretPath, []byte(secret), 0600); err != nil {
		return "", fmt.Errorf("cannot write session secret to %s: %w", secretPath, err)
	}
	return secret, nil
}
