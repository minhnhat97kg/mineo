const CONTROL_PATH = '/services/pty/control';

export type PaneRole = 'neovim' | 'terminal';

export interface SpawnOptions {
    instanceId: string;
    role: PaneRole;
    cols: number;
    rows: number;
    cwd?: string;
}

class PtyControlService {
    private ws: WebSocket | null = null;
    private queue: string[] = [];

    constructor() { this.connect(); }

    private connect(): void {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}${CONTROL_PATH}`);
        this.ws.addEventListener('open', () => {
            for (const m of this.queue) this.ws!.send(m);
            this.queue = [];
        });
        this.ws.addEventListener('close', () => setTimeout(() => this.connect(), 2000));
    }

    private send(msg: object): void {
        const s = JSON.stringify(msg);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
        else this.queue.push(s);
    }

    spawn(opts: SpawnOptions): void { this.send({ type: 'spawn', ...opts }); }
    kill(instanceId: string): void { this.send({ type: 'kill', instanceId }); }
}

export const ptyControlService = new PtyControlService();
