package config

import (
	"net"
	"time"
)

// CheckNvimReady tests whether the nvim RPC socket is accepting connections.
// Returns true if a connection can be established within the timeout.
func CheckNvimReady(sockPath string, timeoutMs int) bool {
	if timeoutMs <= 0 {
		timeoutMs = 500
	}
	conn, err := net.DialTimeout("unix", sockPath, time.Duration(timeoutMs)*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
