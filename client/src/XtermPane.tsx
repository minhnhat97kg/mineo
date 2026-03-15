import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { PaneRole } from './pty-control-service';

interface Props {
    instanceId: string;
    role: PaneRole;
}

export function XtermPane({ instanceId, role: _role }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = containerRef.current!;
        const term = new Terminal({
            cursorStyle: 'block',
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 13,
            theme: { background: '#0d0d17' },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(el);

        let lastCols = 0;
        let lastRows = 0;
        let resizeWs: WebSocket | null = null;

        const fitAndResize = () => {
            try { fitAddon.fit(); } catch { return; }
            term.refresh(0, term.rows - 1);
            if (term.cols === lastCols && term.rows === lastRows) return;
            lastCols = term.cols; lastRows = term.rows;
            if (resizeWs?.readyState === WebSocket.OPEN && term.cols > 0)
                resizeWs.send(`${term.cols},${term.rows}`);
        };

        let roTimer: ReturnType<typeof setTimeout> | undefined;
        const ro = new ResizeObserver(() => { clearTimeout(roTimer); roTimer = setTimeout(fitAndResize, 50); });
        ro.observe(el);

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const base = `${proto}://${location.host}/pty/${instanceId}`;
        const enc = new TextEncoder();

        const dws = new WebSocket(`${base}/data`);
        dws.binaryType = 'arraybuffer';
        dws.addEventListener('message', e => {
            term.write(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : enc.encode(e.data));
        });
        dws.addEventListener('close', () => {
            term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
        });
        dws.addEventListener('error', () => {
            term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
        });
        term.onData(d => { if (dws.readyState === WebSocket.OPEN) dws.send(enc.encode(d)); });
        term.onBinary(d => {
            const b = new Uint8Array(d.length);
            for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
            if (dws.readyState === WebSocket.OPEN) dws.send(b);
        });

        const rws = new WebSocket(`${base}/resize`);
        rws.addEventListener('open', () => { resizeWs = rws; fitAndResize(); });
        rws.addEventListener('close', () => { resizeWs = null; });

        requestAnimationFrame(() => {
            fitAndResize();
            setTimeout(() => { fitAndResize(); term.focus(); }, 50);
        });

        return () => {
            clearTimeout(roTimer);
            ro.disconnect();
            dws.close();
            rws.close();
            term.dispose();
        };
    }, [instanceId]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
