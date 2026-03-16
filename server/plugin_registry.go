package main

import "net/http"

// Plugin is the interface every server-side plugin must implement.
//
// Example implementation:
//
//	type MyPlugin struct{}
//
//	func init() { RegisterPlugin(&MyPlugin{}) }
//
//	func (p *MyPlugin) Name() string { return "my-plugin" }
//
//	func (p *MyPlugin) Register(mux *http.ServeMux, cfg *MineoCfg) {
//	    mux.HandleFunc("GET /api/plugin/my-plugin/data", func(w http.ResponseWriter, r *http.Request) {
//	        writeJSON(w, http.StatusOK, map[string]string{"hello": "world"})
//	    })
//	}
type Plugin interface {
	// Name returns the plugin's unique ID (must match the client-side plugin id).
	Name() string
	// Register adds any HTTP routes this plugin needs.
	// The convention is to prefix routes with /api/plugin/<name>/.
	Register(mux *http.ServeMux, cfg *MineoCfg)
}

var registeredPlugins []Plugin

// RegisterPlugin adds a plugin to the global registry.
// Call this from an init() function in your plugin file.
func RegisterPlugin(p Plugin) {
	registeredPlugins = append(registeredPlugins, p)
}

// MountPlugins calls Register on every registered plugin.
// Called once from main() after all other routes are set up.
func MountPlugins(mux *http.ServeMux, cfg *MineoCfg) {
	for _, p := range registeredPlugins {
		p.Register(mux, cfg)
	}
}
