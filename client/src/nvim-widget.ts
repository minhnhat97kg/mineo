import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { PaneRole } from './pty-control-service';

export class NvimWidget {
    readonly instanceId: string;
    readonly role: PaneRole;
    readonly element: HTMLElement;

    private term: Terminal;
    private fitAddon: FitAddon;
    private dataWs: WebSocket | null = null;
    private resizeWs: WebSocket | null = null;
    private _onExit: (() => void) | null = null;
    private termOpened = false;
    private lastCols = 0;
    private lastRows = 0;
    private ro: ResizeObserver;

    constructor(instanceId: string, role: PaneRole) {
        this.instanceId = instanceId;
        this.role = role;
        this.element = document.createElement('div');
        this.element.className = 'nvim-widget';

        this.term = new Terminal({
            cursorStyle: 'block',
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 13,
            theme: { background: '#0d0d17' },
        });
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);

        let t: ReturnType<typeof setTimeout> | undefined;
        this.ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.fitAndResize(), 50); });
        this.ro.observe(this.element);
    }

    attach(): void {
        if (!this.termOpened) {
            this.term.open(this.element);
            this.termOpened = true;
        }
        requestAnimationFrame(() => {
            this.fitAndResize();
            setTimeout(() => { this.fitAndResize(); this.term.focus(); }, 50);
        });
    }

    connectChannels(): void {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const base = `${proto}://${location.host}/pty/${this.instanceId}`;
        const enc = new TextEncoder();

        const dws = new WebSocket(`${base}/data`);
        dws.binaryType = 'arraybuffer';
        dws.addEventListener('open', () => { this.dataWs = dws; });
        dws.addEventListener('message', e => {
            this.term.write(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : enc.encode(e.data));
        });
        dws.addEventListener('close', () => { this.dataWs = null; this._onExit?.(); });
        this.term.onData(d => { if (dws.readyState === WebSocket.OPEN) dws.send(enc.encode(d)); });
        this.term.onBinary(d => {
            const b = new Uint8Array(d.length);
            for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
            if (dws.readyState === WebSocket.OPEN) dws.send(b);
        });

        const rws = new WebSocket(`${base}/resize`);
        rws.addEventListener('open', () => { this.resizeWs = rws; this.sendResize(); });
        rws.addEventListener('close', () => { this.resizeWs = null; });
    }

    onExit(cb: () => void): void { this._onExit = cb; }
    focus(): void { this.term.focus(); }

    fitAndResize(): void {
        if (!this.termOpened) return;
        try { this.fitAddon.fit(); } catch { return; }
        this.term.refresh(0, this.term.rows - 1);
        if (this.term.cols === this.lastCols && this.term.rows === this.lastRows) return;
        this.lastCols = this.term.cols; this.lastRows = this.term.rows;
        this.sendResize();
    }

    private sendResize(): void {
        if (this.resizeWs?.readyState === WebSocket.OPEN && this.term.cols > 0)
            this.resizeWs.send(`${this.term.cols},${this.term.rows}`);
    }

    dispose(): void {
        this.ro.disconnect();
        this.dataWs?.close();
        this.resizeWs?.close();
        this.term.dispose();
    }
}
