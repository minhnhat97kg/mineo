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
    let proc = this.servers.get(lang);

    if (!proc || proc.exitCode !== null) {
      proc = this.spawnServer(lang, cmd);
    }

    // WebSocket message → lang server stdin
    ws.on('message', (data) => {
      if (proc && proc.stdin && proc.exitCode === null) {
        proc.stdin.write(data instanceof Buffer ? data : Buffer.from(data as unknown as string));
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
      proc!.stdout!.off('data', onData);
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
}
