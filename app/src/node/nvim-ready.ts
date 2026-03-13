import net from 'net';

const NVIM_SOCK = '/tmp/nvim.sock';

/**
 * Check whether the nvim RPC socket is accepting connections.
 *
 * Uses socket.setTimeout() + the 'timeout' event for the timeout path
 * because net.createConnection does not accept a timeout option directly;
 * the 'timeout' event fires but does NOT close the socket — we must call
 * socket.destroy() explicitly.
 *
 * Resolves true as soon as a connection is established (the 'connect' event).
 * The nvim msgpack-RPC socket does not send a greeting; connection success
 * is sufficient to confirm nvim is ready to accept RPC calls.
 *
 * @param sockPath Path to the Unix socket (defaults to /tmp/nvim.sock)
 * @param timeoutMs Connection timeout in milliseconds (defaults to 500)
 * @returns true if connection succeeded, false on any error or timeout
 */
export function checkNvimReady(
  sockPath: string = NVIM_SOCK,
  timeoutMs: number = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      // 'timeout' does not close the socket — must destroy manually
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      // ENOENT (no such file), ECONNREFUSED, etc. — all map to false
      resolve(false);
    });
  });
}
