import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { ptyControlService, PaneRole } from '../pty-control-service';
import { settingsStore } from '../settings-store';
import { getTheme, toXtermTheme } from '../themes';
import { cwd } from '../layout-utils';
import { TermContextMenu, useTermContextMenu } from './TermContextMenu';

export interface PtyPaneProps {
    instanceId: string;
    role: PaneRole;
    termMapRef: React.RefObject<Map<string, { term: Terminal; fitAddon: FitAddon }>>;
    lastFocusedNvimRef: React.RefObject<string | null>;
    keyboardLocked: boolean;
}

export function PtyPane({ instanceId, role, termMapRef, lastFocusedNvimRef, keyboardLocked }: PtyPaneProps) {
    const elRef   = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const dwsRef  = useRef<WebSocket | null>(null);

    // Apply keyboardLocked to xterm's hidden textarea — readOnly prevents
    // the virtual keyboard from appearing on focus on iOS/iPadOS
    useEffect(() => {
        const textarea = elRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
        if (textarea) textarea.readOnly = keyboardLocked;
    }, [keyboardLocked]);

    const sendData = useCallback((data: string) => {
        const dws = dwsRef.current;
        if (dws?.readyState === WebSocket.OPEN) {
            dws.send(new TextEncoder().encode(data));
        }
    }, []);

    const { menu, close } = useTermContextMenu({ role, elRef, termRef, sendData });

    useEffect(() => {
        const el = elRef.current;
        if (!el) return;

        const currentSettings = settingsStore.get();
        const currentTheme = getTheme(currentSettings.theme);

        const term = new Terminal({
            allowProposedApi: true,
            cursorStyle: 'block',
            fontFamily: currentSettings.fontFamily,
            fontSize: currentSettings.fontSize,
            theme: toXtermTheme(currentTheme),
            scrollback: 5000,  // cap at 5,000 lines to prevent unbounded memory growth
        });
        const fitAddon = new FitAddon();
        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.loadAddon(fitAddon);
        term.unicode.activeVersion = '11';
        term.open(el);
        termRef.current = term;
        termMapRef.current.set(instanceId, { term, fitAddon });
        // Apply initial keyboard lock state to the textarea xterm just created
        const textarea = el.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
        if (textarea) textarea.readOnly = keyboardLocked;
        // Re-apply theme immediately after open() to avoid xterm's green default foreground flash
        term.options.theme = toXtermTheme(currentTheme);

        if (role === 'neovim') {
            lastFocusedNvimRef.current = instanceId;
            term.onData(() => { lastFocusedNvimRef.current = instanceId; });
        }

        const unsubSettings = settingsStore.subscribe(s => {
            const entry = termMapRef.current.get(instanceId);
            if (!entry) return;
            const theme = getTheme(s.theme);
            entry.term.options.fontFamily = s.fontFamily;
            entry.term.options.fontSize = s.fontSize;
            entry.term.options.theme = toXtermTheme(theme);
            try { entry.fitAddon.fit(); } catch { /* ignore */ }
        });

        let disposed = false;
        let dataWs: WebSocket | null = null;
        let resizeWs: WebSocket | null = null;
        let roTimer: ReturnType<typeof setTimeout> | undefined;
        let lastCols = 0;
        let lastRows = 0;

        const fitAndResize = () => {
            try { fitAddon.fit(); } catch { return; }
            term.refresh(0, term.rows - 1);
            if (term.cols === lastCols && term.rows === lastRows) return;
            lastCols = term.cols; lastRows = term.rows;
            if (resizeWs?.readyState === WebSocket.OPEN && term.cols > 0)
                resizeWs.send(`${term.cols},${term.rows}`);
        };

        const ro = new ResizeObserver(() => {
            clearTimeout(roTimer);
            roTimer = setTimeout(fitAndResize, 50);
        });
        ro.observe(el);

        // Fit before spawning so the PTY is created at the actual rendered size
        try { fitAddon.fit(); } catch { /* el may not be laid out yet; resize observer will correct */ }
        const spawnCols = term.cols > 0 ? term.cols : 120;
        const spawnRows = term.rows > 0 ? term.rows : 30;

        // Check if the window already exists in tmux (reconnect scenario)
        async function connect() {
            const windows = await ptyControlService.list();
            const exists = windows.some(w => w.id === instanceId);

            if (!exists) {
                // Fresh window — spawn it
                await ptyControlService.spawn({ instanceId, role, cols: spawnCols, rows: spawnRows, cwd: cwd() });
            }
            // else: window already exists in tmux, just attach the WebSocket
            // Scrollback is sent by server automatically on data WS open

            if (disposed) return;

            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const base = `${proto}://${location.host}/pty/${instanceId}`;
            const enc = new TextEncoder();

            const dws = new WebSocket(`${base}/data`);
            dataWs = dws;
            dwsRef.current = dws;
            dws.binaryType = 'arraybuffer';
            dws.addEventListener('message', e => {
                term.write(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : enc.encode(e.data));
            });
            dws.addEventListener('close', (event) => {
                dwsRef.current = null;
                const reason = event.reason
                    ? ` (${event.reason})`
                    : event.code !== 1000 && event.code !== 1001
                        ? ` (code ${event.code})`
                        : '';
                term.write(`\r\n\x1b[31m[disconnected${reason}]\x1b[0m\r\n`);
                if (!disposed) window.dispatchEvent(new CustomEvent('mineo:disconnected'));
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
            resizeWs = rws;
            rws.addEventListener('open', () => { resizeWs = rws; fitAndResize(); });
            rws.addEventListener('close', () => { resizeWs = null; });

            requestAnimationFrame(() => {
                fitAndResize();
                setTimeout(() => { fitAndResize(); term.focus(); }, 50);
            });
        }

        connect();

        return () => {
            disposed = true;
            clearTimeout(roTimer);
            ro.disconnect();
            dataWs?.close();
            resizeWs?.close();
            term.dispose();
            termRef.current = null;
            termMapRef.current.delete(instanceId);
            unsubSettings();
            // DO NOT kill — tmux window stays alive.
            // Kill is handled by LayoutContainer's onAction when a tab is closed.
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // No opacity hack — tmux attach is instant since the process is already running
    return (
        <>
            <div ref={elRef} style={{ width: '100%', height: '100%' }} />
            {createPortal(<TermContextMenu state={menu} onClose={close} />, document.body)}
        </>
    );
}
