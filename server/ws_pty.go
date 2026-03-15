package main

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
)

// ptyPathRe matches /pty/<instanceId>/<channel>
var ptyPathRe = regexp.MustCompile(`^/pty/([^/]+)/(data|resize|buffer-watch)$`)

// RegisterPtyWebSockets registers all PTY-related WebSocket upgrade handlers.
func RegisterPtyWebSockets(mux *http.ServeMux, upgrader *websocket.Upgrader, ptyMgr *PtyManager) {
	mux.HandleFunc("/services/pty/control", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws-pty] control upgrade failed: %v", err)
			return
		}
		handleControl(conn, ptyMgr)
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
			handleData(conn, instanceID, ptyMgr)
		case "resize":
			handleResize(conn, instanceID, ptyMgr)
		case "buffer-watch":
			handleBufferWatch(conn, instanceID, ptyMgr)
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

func handleControl(conn *websocket.Conn, ptyMgr *PtyManager) {
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
			role := PaneRole(msg.Role)
			if role != RoleNeovim && role != RoleTerminal {
				role = RoleTerminal
			}
			spawnErr := ptyMgr.Spawn(msg.InstanceID, role, uint16(cols), uint16(rows), msg.Cwd)
			reply := controlReply{InstanceID: msg.InstanceID, Status: "ok"}
			if spawnErr != nil {
				reply.Status = "error"
				reply.Error = spawnErr.Error()
			}
			data, _ := json.Marshal(reply)
			conn.WriteMessage(websocket.TextMessage, data)

		case "kill":
			ptyMgr.Kill(msg.InstanceID)
			reply := controlReply{InstanceID: msg.InstanceID, Status: "ok"}
			data, _ := json.Marshal(reply)
			conn.WriteMessage(websocket.TextMessage, data)
		}
	}
}

func handleData(conn *websocket.Conn, instanceID string, ptyMgr *PtyManager) {
	// Subscribe to PTY output and forward to WebSocket
	unsub := ptyMgr.OnData(instanceID, func(data []byte) {
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
		ptyMgr.Write(instanceID, raw)
	}
}

func handleResize(conn *websocket.Conn, instanceID string, ptyMgr *PtyManager) {
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
		ptyMgr.Resize(instanceID, uint16(cols), uint16(rows))
	}
}

func handleBufferWatch(conn *websocket.Conn, instanceID string, ptyMgr *PtyManager) {
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
			sockPath := ptyMgr.GetSocketPath(instanceID)
			if sockPath == "" {
				continue
			}

			nvimBin := ptyMgr.GetNvimBin()
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
