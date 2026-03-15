import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const LSP_SERVERS: Record<string, string[]> = {
  typescript: ['typescript-language-server', '--stdio'],
  python:     ['pylsp'],
  go:         ['gopls'],
  rust:       ['rust-analyzer'],
};

// ── LSP Content-Length framing helpers ───────────────────────────────────────

const HEADER_SEP = '\r\n\r\n';
const CL_PREFIX = 'Content-Length: ';

/** Encode a JSON-RPC object as a Content-Length-framed LSP message. */
function frameLsp(msg: object): Buffer {
  const body = JSON.stringify(msg);
  const header = `${CL_PREFIX}${Buffer.byteLength(body, 'utf8')}${HEADER_SEP}`;
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body, 'utf8')]);
}

/**
 * Minimal stateful LSP frame parser.
 * Accumulates incoming bytes and emits complete parsed JSON objects.
 */
class LspParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): object[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const msgs: object[] = [];
    while (true) {
      const raw = this.buf.toString('utf8');
      const sepIdx = raw.indexOf(HEADER_SEP);
      if (sepIdx === -1) break;
      const header = raw.slice(0, sepIdx);
      const clLine = header.split('\r\n').find(l => l.startsWith(CL_PREFIX));
      if (!clLine) break;
      const contentLength = parseInt(clLine.slice(CL_PREFIX.length), 10);
      if (isNaN(contentLength)) break;
      const headerBytes = Buffer.byteLength(raw.slice(0, sepIdx + HEADER_SEP.length), 'utf8');
      const totalNeeded = headerBytes + contentLength;
      if (this.buf.length < totalNeeded) break;
      const bodyStr = this.buf.slice(headerBytes, totalNeeded).toString('utf8');
      this.buf = this.buf.slice(totalNeeded);
      try { msgs.push(JSON.parse(bodyStr)); } catch { /* malformed — skip */ }
    }
    return msgs;
  }
}

/**
 * LspServerManager:
 * 1. Intercepts HTTP upgrade requests for /lsp/<lang>
 * 2. Spawns the language server child process on demand (once per lang, reused)
 * 3. Bridges WebSocket messages <-> language server stdio
 *
 * Re-connection handling: language servers reject a second `initialize` request
 * (error -32600) when the process is already running. When a client reconnects
 * after switching editor modes, the server intercepts the `initialize` message,
 * replies with a synthetic success response, then routes all subsequent traffic
 * directly to the process. This lets the client complete its handshake without
 * the server process ever seeing a duplicate initialize.
 *
 * Language servers must be on PATH; missing ones cause the WS upgrade to be
 * rejected with HTTP 404 (client falls back silently).
 */
export class LspServerManager {
  private servers = new Map<string, ChildProcess>();
  /** Tracks which language servers have already completed the initialize handshake. */
  private initialized = new Set<string>();
  private wss = new WebSocketServer({ noServer: true });

  attachWebSocket(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      const match = url.match(/^\/lsp\/(\w+)$/);
      if (!match) return;

      const lang = match[1];
      const cmd = LSP_SERVERS[lang];
      if (!cmd) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, lang, cmd);
      });
    });
  }

  private handleConnection(ws: WebSocket, lang: string, cmd: string[]): void {
    // Use map membership as the single source of truth for process liveness.
    // The 'exit'/'error' handlers delete the entry when the process dies.
    if (!this.servers.has(lang)) {
      try {
        this.spawnServer(lang, cmd);
      } catch (err) {
        console.error(`[LspServerManager] ${lang} spawn failed:`, err);
        ws.close(1011, 'Language server failed to start');
        return;
      }
    }
    const proc = this.servers.get(lang)!;

    // Lang server stdout → WebSocket.
    // Each WebSocket gets its own stdout listener so multiple clients
    // (e.g. reconnects) all receive the data.
    // On the first connection, also watch stdout to detect when the server
    // sends its initialize response — at that point we mark it as initialized
    // so future reconnections know to intercept duplicate initialize requests.
    const onData = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
      // Mark as initialized once the server has replied to the first initialize.
      // We do this lazily on any stdout data after the client has connected,
      // because the first response from a fresh server is always the initialize result.
      if (!this.initialized.has(lang)) {
        this.initialized.add(lang);
        console.log(`[LspServerManager] ${lang} marked as initialized`);
      }
    };
    proc.stdout!.on('data', onData);

    // Whether this connection has already had its initialize intercepted/forwarded.
    // Used to track first-message state per connection (not per process).
    const isReconnect = this.initialized.has(lang);
    const parser = isReconnect ? new LspParser() : null;
    let initIntercepted = !isReconnect; // fresh process: no intercept needed

    // WebSocket message → lang server stdin
    // For the first connection to a fresh process: forward everything verbatim.
    // For reconnections to an already-initialized process: parse the byte stream,
    // intercept the initialize request and reply synthetically (without forwarding
    // to the process), then forward all subsequent messages verbatim.
    const onWsMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (!proc.stdin || !this.servers.has(lang)) return;
      const buf = data instanceof Buffer ? data
                : data instanceof ArrayBuffer ? Buffer.from(data)
                : Buffer.concat(data as Buffer[]);

      // Fast path: process is fresh / intercept already done — forward verbatim.
      if (initIntercepted) {
        proc.stdin.write(buf);
        return;
      }

      // Intercept path: parse the stream looking for the initialize request.
      const msgs = parser!.push(buf);
      for (const msg of msgs) {
        const m = msg as { jsonrpc?: string; id?: number; method?: string };
        if (m.method === 'initialize' && m.id !== undefined) {
          // Send synthetic initialize result back to the client.
          // The capabilities here match what a live gopls/pylsp would return
          // for the subset we actually use (hover, completion, definition).
          const syntheticResult = {
            jsonrpc: '2.0',
            id: m.id,
            result: {
              capabilities: {
                textDocumentSync: { openClose: true, change: 1 },
                hoverProvider: true,
                completionProvider: { triggerCharacters: ['.', ':', '"', "'", '/', '@', '<'] },
                definitionProvider: true,
              },
            },
          };
          ws.send(frameLsp(syntheticResult));
          initIntercepted = true;
          console.log(`[LspServerManager] ${lang} initialize intercepted for reconnecting client`);
          // Do NOT forward the initialize request to the process.
        } else {
          // All other messages (including 'initialized' notification) go through.
          proc.stdin.write(frameLsp(msg));
        }
      }
    };
    ws.on('message', onWsMessage);

    ws.on('close', () => {
      // Remove this client's listeners — don't kill the server process.
      proc.stdout!.off('data', onData);
      ws.off('message', onWsMessage);
    });
  }

  private spawnServer(lang: string, cmd: string[]): ChildProcess {
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.on('error', (err) => {
      console.error(`[LspServerManager] ${lang} failed to start: ${err.message}`);
      this.servers.delete(lang);
      this.initialized.delete(lang);
    });

    proc.on('exit', (code) => {
      console.error(`[LspServerManager] ${lang} exited with code ${code}`);
      this.servers.delete(lang);
      this.initialized.delete(lang);
    });

    proc.stderr!.on('data', (d: Buffer) => {
      // Language server stderr: log at debug level — useful to diagnose LSP startup failures.
      const line = d.toString().trim();
      if (line) console.debug(`[LspServerManager][${lang}] ${line}`);
    });

    this.servers.set(lang, proc);
    return proc;
  }

  stop(): void {
    this.wss.close();
  }
}

export const lspServerManager = new LspServerManager();
