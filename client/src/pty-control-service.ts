const CONTROL_PATH = '/services/pty/control';

export type PaneRole = 'neovim' | 'terminal';

export interface SpawnOptions {
    instanceId: string;
    role: PaneRole;
    cols: number;
    rows: number;
    cwd?: string;
}

export interface WindowInfo {
    id: string;
    role: PaneRole;
    attached: boolean;
}

class PtyControlService {
    private ws: WebSocket | null = null;
    private queue: string[] = [];
    private pending = new Map<string, () => void>();
    private ready: Promise<void>;
    private resolveReady!: () => void;

    constructor() {
        this.ready = new Promise(r => { this.resolveReady = r; });
        this.connect();
    }

    private connect(): void {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}${CONTROL_PATH}`);
        this.ws.addEventListener('open', () => {
            for (const m of this.queue) this.ws!.send(m);
            this.queue = [];
            this.resolveReady();
        });
        this.ws.addEventListener('message', (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.status === 'ok' && msg.instanceId) {
                    const resolve = this.pending.get(msg.instanceId);
                    if (resolve) {
                        this.pending.delete(msg.instanceId);
                        resolve();
                    }
                }
            } catch { /* ignore */ }
        });
        this.ws.addEventListener('close', () => {
            this.ready = new Promise(r => { this.resolveReady = r; });
            setTimeout(() => this.connect(), 2000);
        });
    }

    private send(msg: object): void {
        const s = JSON.stringify(msg);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
        else this.queue.push(s);
    }

    /** Spawn a PTY and resolve when the server acknowledges it. */
    async spawn(opts: SpawnOptions): Promise<void> {
        await this.ready;
        return new Promise<void>((resolve) => {
            this.pending.set(opts.instanceId, resolve);
            this.send({ type: 'spawn', ...opts });
            // Timeout fallback — don't hang forever
            setTimeout(() => {
                if (this.pending.has(opts.instanceId)) {
                    this.pending.delete(opts.instanceId);
                    resolve();
                }
            }, 3000);
        });
    }

    /** Kill a window (destroy tmux window + process) */
    kill(instanceId: string): void { this.send({ type: 'kill', instanceId }); }

    /** Detach a window (disconnect but keep alive in tmux) */
    detach(instanceId: string): void { this.send({ type: 'detach', instanceId }); }

    /** List all tmux windows in the session */
    async list(): Promise<WindowInfo[]> {
        try {
            const res = await fetch('/api/session/windows');
            const data = await res.json();
            return data.windows ?? [];
        } catch {
            return [];
        }
    }
}

export const ptyControlService = new PtyControlService();
