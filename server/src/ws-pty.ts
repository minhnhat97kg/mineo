import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { ptyManager } from './pty-manager';

export function attachPtyWebSockets(server: http.Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '', `http://${req.headers.host}`).pathname;

        if (pathname === '/services/pty/control') {
            wss.handleUpgrade(req, socket, head, (ws) => handleControl(ws));
            return;
        }

        const m = pathname.match(/^\/pty\/([^/]+)\/(data|resize|buffer-watch)$/);
        if (m) {
            const [, instanceId, channel] = m;
            wss.handleUpgrade(req, socket, head, (ws) => {
                if (channel === 'data') handleData(ws, instanceId);
                else if (channel === 'resize') handleResize(ws, instanceId);
                else handleBufferWatch(ws, instanceId);
            });
        }
    });
}

function handleControl(ws: WebSocket): void {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'spawn') {
                ptyManager.spawn(msg.instanceId, msg.role, msg.cols ?? 120, msg.rows ?? 30, msg.cwd);
                ws.send(JSON.stringify({ instanceId: msg.instanceId, status: 'ok' }));
            } else if (msg.type === 'kill') {
                ptyManager.kill(msg.instanceId);
                ws.send(JSON.stringify({ instanceId: msg.instanceId, status: 'ok' }));
            }
        } catch { /* ignore */ }
    });
}

function handleData(ws: WebSocket, instanceId: string): void {
    const unsub = ptyManager.onData(instanceId, (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    ws.on('message', (raw) => {
        const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
        ptyManager.write(instanceId, data);
    });
    ws.on('close', () => unsub());
}

function handleResize(ws: WebSocket, instanceId: string): void {
    ws.on('message', (raw) => {
        const [cols, rows] = raw.toString().split(',').map(Number);
        if (cols > 0 && rows > 0) ptyManager.resize(instanceId, cols, rows);
    });
}

function handleBufferWatch(ws: WebSocket, instanceId: string): void {
    let last = '';
    let inFlight = false;
    const interval = setInterval(async () => {
        if (inFlight || ws.readyState !== WebSocket.OPEN) return;
        inFlight = true;
        try {
            const sockPath = ptyManager.getSocketPath(instanceId);
            if (!sockPath) return;
            const { execFile } = await import('child_process');
            const file = await new Promise<string>((res, rej) =>
                execFile(ptyManager.getNvimBin(), ['--server', sockPath, '--remote-expr', 'expand("%:p")'],
                    { timeout: 300 }, (err, out) => err ? rej(err) : res(out.trim()))
            );
            if (file && file !== last) { last = file; ws.send(file); }
        } catch { /* nvim not ready */ }
        finally { inFlight = false; }
    }, 500);
    ws.on('close', () => clearInterval(interval));
}
