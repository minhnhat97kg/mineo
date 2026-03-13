import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const LSP_SERVERS: Record<string, string[]> = {
  typescript: ['typescript-language-server', '--stdio'],
  python:     ['pylsp'],
  go:         ['gopls'],
  rust:       ['rust-analyzer'],
};

/**
 * LspServerManager — BackendApplicationContribution that:
 * 1. Intercepts HTTP upgrade requests for /lsp/<lang>
 * 2. Spawns the language server child process on demand (once per lang, reused)
 * 3. Bridges WebSocket messages <-> language server stdio
 *
 * Language servers must be on PATH; missing ones cause the WS upgrade to be
 * rejected with HTTP 404 (client falls back silently).
 */
@injectable()
export class LspServerManager implements BackendApplicationContribution {
  private servers = new Map<string, ChildProcess>();
  private wss = new WebSocketServer({ noServer: true });

  onStart(server: http.Server): void {
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

    // WebSocket message → lang server stdin
    ws.on('message', (data) => {
      if (proc.stdin && this.servers.has(lang)) {
        const buf = data instanceof Buffer ? data
                  : data instanceof ArrayBuffer ? Buffer.from(data)
                  : Buffer.concat(data as Buffer[]);
        proc.stdin.write(buf);
      }
    });

    // Lang server stdout → WebSocket
    const onData = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    };
    proc.stdout!.on('data', onData);

    ws.on('close', () => {
      proc.stdout!.off('data', onData);
      // Keep the server process alive for reconnects
    });
  }

  private spawnServer(lang: string, cmd: string[]): ChildProcess {
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.on('error', (err) => {
      console.error(`[LspServerManager] ${lang} failed to start: ${err.message}`);
      this.servers.delete(lang);
    });

    proc.on('exit', (code) => {
      console.error(`[LspServerManager] ${lang} exited with code ${code}`);
      this.servers.delete(lang);
    });

    proc.stderr!.on('data', (_d: Buffer) => {
      // Language servers write diagnostic logs to stderr — swallowed to avoid noise.
    });

    this.servers.set(lang, proc);
    return proc;
  }

  onStop(): void {
    this.wss.close();
  }
}
