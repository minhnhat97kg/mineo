import net from 'net';

const NVIM_SOCK = '/tmp/nvim.sock';

/**
 * Check whether the nvim RPC socket is accepting connections and responding.
 *
 * Opens a connection and sets a timeout for socket inactivity. If data is received
 * (indicating the socket is responsive), returns true. If the connection times out
 * without any data, returns false.
 *
 * @param sockPath Path to the Unix socket (defaults to /tmp/nvim.sock)
 * @param timeoutMs Connection/response timeout in milliseconds (defaults to 500)
 * @returns true if socket connects and responds within timeout, false otherwise
 */
export function checkNvimReady(
  sockPath: string = NVIM_SOCK,
  timeoutMs: number = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      // Connection successful, but keep waiting for data or timeout
      // (don't resolve yet - let timeout or data event decide)
    });

    socket.on('data', () => {
      // Received response - socket is responsive
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('timeout', () => {
      // Timeout fired - socket didn't respond within timeoutMs
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      // Connection error (ENOENT, ECONNREFUSED, etc.) - socket not available
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}
