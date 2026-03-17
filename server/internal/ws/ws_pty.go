package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"mineo/server/internal/tmux"
)

// ptyPathRe matches /pty/<instanceId>/<channel>
var ptyPathRe = regexp.MustCompile(`^/pty/([^/]+)/(data|resize|buffer-watch)$`)

// RegisterPtyWebSockets registers all PTY-related WebSocket upgrade handlers.
func RegisterPtyWebSockets(mux *http.ServeMux, upgrader *websocket.Upgrader, tmuxMgr *tmux.TmuxManager) {
	mux.HandleFunc("/services/pty/control", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws-pty] control upgrade failed: %v", err)
			return
		}
		handleControl(conn, tmuxMgr)
	})

	// Dynamic PTY paths: /pty/{id}/{channel}
	// We register a broad prefix and parse the path ourselves.
	mux.HandleFunc("/pty/", func(w http.ResponseWriter, r *http.Request) {
		m := ptyPathRe.FindStringSubmatch(r.URL.Path)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		instanceID := m[1]
		channel := m[2]

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws-pty] %s upgrade failed: %v", channel, err)
			return
		}

		switch channel {
		case "data":
			handleData(conn, instanceID, tmuxMgr)
		case "resize":
			handleResize(conn, instanceID, tmuxMgr)
		case "buffer-watch":
			handleBufferWatch(conn, instanceID, tmuxMgr)
		}
	})
}

// controlMsg is the JSON structure for control channel messages.
type controlMsg struct {
	Type       string `json:"type"`
	InstanceID string `json:"instanceId"`
	Role       string `json:"role"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	Cwd        string `json:"cwd"`
}

// controlReply is sent back on the control channel.
type controlReply struct {
	InstanceID string `json:"instanceId"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
}

func handleControl(conn *websocket.Conn, tmuxMgr *tmux.TmuxManager) {
	defer conn.Close()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg controlMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		cols := msg.Cols
		if cols <= 0 {
			cols = 120
		}
		rows := msg.Rows
		if rows <= 0 {
			rows = 30
		}

		switch msg.Type {
		case "spawn":
			role := tmux.PaneRole(msg.Role)
			if role != tmux.RoleNeovim && role != tmux.RoleTerminal {
				role = tmux.RoleTerminal
			}
			spawnErr := tmuxMgr.Spawn(msg.InstanceID, role, uint16(cols), uint16(rows), msg.Cwd)
			reply := controlReply{InstanceID: msg.InstanceID, Status: "ok"}
			if spawnErr != nil {
				reply.Status = "error"
				reply.Error = spawnErr.Error()
			}
			data, _ := json.Marshal(reply)
			conn.WriteMessage(websocket.TextMessage, data)

		case "kill":
			tmuxMgr.Kill(msg.InstanceID)
			reply := controlReply{InstanceID: msg.InstanceID, Status: "ok"}
			data, _ := json.Marshal(reply)
			conn.WriteMessage(websocket.TextMessage, data)

		case "detach":
			tmuxMgr.Detach(msg.InstanceID)
			reply := controlReply{InstanceID: msg.InstanceID, Status: "ok"}
			data, _ := json.Marshal(reply)
			conn.WriteMessage(websocket.TextMessage, data)

		case "list":
			windows := tmuxMgr.ListWindows()
			type listReply struct {
				Type    string           `json:"type"`
				Windows []tmux.WindowInfo `json:"windows"`
			}
			data, _ := json.Marshal(listReply{Type: "list", Windows: windows})
			conn.WriteMessage(websocket.TextMessage, data)
		}
	}
}

func handleData(conn *websocket.Conn, instanceID string, tmuxMgr *tmux.TmuxManager) {
	// Send scrollback first, before subscribing to live output
	scrollback, err := tmuxMgr.CaptureScrollback(instanceID, 1000)
	if err == nil && len(scrollback) > 0 {
		conn.WriteMessage(websocket.BinaryMessage, scrollback)
	}

	// Subscribe to PTY output and forward to WebSocket
	unsub := tmuxMgr.OnData(instanceID, func(data []byte) {
		conn.WriteMessage(websocket.BinaryMessage, data)
	})
	defer unsub()
	defer conn.Close()

	// Read from WebSocket and write to PTY stdin
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		tmuxMgr.Write(instanceID, raw)
	}
}

func handleResize(conn *websocket.Conn, instanceID string, tmuxMgr *tmux.TmuxManager) {
	defer conn.Close()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		parts := strings.SplitN(string(raw), ",", 2)
		if len(parts) != 2 {
			continue
		}
		cols, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
		rows, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err1 != nil || err2 != nil || cols <= 0 || rows <= 0 {
			continue
		}
		tmuxMgr.Resize(instanceID, uint16(cols), uint16(rows))
	}
}

func handleBufferWatch(conn *websocket.Conn, instanceID string, tmuxMgr *tmux.TmuxManager) {
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Cancel context when connection closes
	go func() {
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				cancel()
				return
			}
		}
	}()

	last := ""
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sockPath := tmuxMgr.GetSocketPath(instanceID)
			if sockPath == "" {
				continue
			}

			nvimBin := tmuxMgr.GetNvimBin()
			cmdCtx, cmdCancel := context.WithTimeout(ctx, 300*time.Millisecond)
			out, err := exec.CommandContext(cmdCtx, nvimBin,
				"--server", sockPath,
				"--remote-expr", `expand("%:p")`).Output()
			cmdCancel()

			if err != nil {
				continue
			}

			file := strings.TrimSpace(string(out))
			if file != "" && file != last {
				last = file
				if err := conn.WriteMessage(websocket.TextMessage, []byte(file)); err != nil {
					return
				}
			}
		}
	}
}
