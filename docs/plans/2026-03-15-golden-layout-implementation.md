# Golden-Layout Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the pure React tab container with golden-layout v2 for drag-and-drop splits, tab reordering, popout windows, and maximize/minimize.

**Architecture:** Use `GoldenLayout` class with `bindComponentEvent`/`unbindComponentEvent` handlers passed to the constructor. Component factory creates xterm Terminal instances with PTY WebSocket lifecycle. Layout structure persisted to localStorage (without component state).

**Tech Stack:** golden-layout v2.6.0, xterm v5, React 19, TypeScript, webpack 5

---

### Task 1: Add GL CSS imports to main.tsx

**Files:**
- Modify: `client/src/main.tsx`

**Step 1: Add golden-layout CSS imports**

Add base + dark theme CSS before the existing imports:

```tsx
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import 'xterm/css/xterm.css';
import './style/main.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('mineo-root')!;
createRoot(rootEl).render(<App />);
```

**Step 2: Commit**

```bash
git add client/src/main.tsx
git commit -m "feat: add golden-layout CSS imports"
```

---

### Task 2: Update main.css — remove old tab styles, add GL theme overrides

**Files:**
- Modify: `client/src/style/main.css`

**Step 1: Replace all `.lc-*` styles with GL theme overrides**

Remove lines 45-96 (all `.lc-*` rules). Add GL overrides that match the `#0d0d17` dark theme:

```css
/* Golden Layout overrides */
.lm_goldenlayout {
    background: #0d0d17;
}
.lm_content {
    background: #0d0d17;
    border-color: #2a2a3e;
}
.lm_header {
    height: 28px;
}
.lm_header .lm_tab {
    font-family: 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
    font-size: 12px;
    color: #888;
    background: #12121f;
    margin-right: 1px;
    padding: 4px 12px 4px 12px;
    height: auto;
}
.lm_header .lm_tab.lm_active {
    color: #fff;
    background: #0d0d17;
    border-bottom: 2px solid #5865f2;
}
.lm_header .lm_tab:hover {
    color: #ccc;
    background: #1a1a2e;
}
.lm_header .lm_tab.lm_active.lm_focused {
    background: #0d0d17;
}
.lm_splitter {
    background: #2a2a3e;
    opacity: 0.3;
}
.lm_splitter:hover,
.lm_splitter.lm_dragging {
    background: #5865f2;
    opacity: 1;
}
.lm_header .lm_controls > * {
    opacity: 0.5;
}
.lm_header .lm_controls > *:hover {
    opacity: 1;
}
.lm_dropTargetIndicator {
    outline: 1px dashed #5865f2;
}
.lm_dropTargetIndicator .lm_inner {
    background: #5865f2;
    opacity: 0.15;
}
.lm_maximised .lm_header {
    background-color: #12121f;
}
.lm_header .lm_tabdropdown_list {
    background: #12121f;
    border: 1px solid #2a2a3e;
}
```

**Step 2: Commit**

```bash
git add client/src/style/main.css
git commit -m "feat: replace custom tab CSS with golden-layout theme overrides"
```

---

### Task 3: Rewrite LayoutContainer.tsx with golden-layout

**Files:**
- Rewrite: `client/src/LayoutContainer.tsx`

**Step 1: Write the new LayoutContainer**

This is the core change. The component:
- Creates a `GoldenLayout` instance with `bindComponentEvent`/`unbindComponentEvent` handlers
- The bind handler creates xterm Terminal + FitAddon, spawns PTY, connects WebSockets
- The unbind handler cleans up (kill PTY, close WebSockets, dispose terminal)
- `loadLayout()` from localStorage or default config
- `addPane()` calls `gl.addComponent()`
- `beforeunload` saves layout structure to localStorage

```tsx
import { useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import {
    GoldenLayout,
    LayoutConfig,
    ResolvedComponentItemConfig,
    ComponentContainer,
} from 'golden-layout';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { ptyControlService, PaneRole } from './pty-control-service';

function uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function cwd(): string | undefined {
    const h = location.hash.replace(/^#/, '');
    return h.startsWith('/') ? h : undefined;
}

const STORAGE_KEY = 'mineo-gl-layout';

const DEFAULT_CONFIG: LayoutConfig = {
    root: {
        type: 'stack',
        content: [
            {
                type: 'component',
                componentType: 'neovim',
                title: 'Neovim',
            },
        ],
    },
    settings: {
        showPopoutIcon: true,
        showMaximiseIcon: true,
        showCloseIcon: true,
    },
    header: {
        popout: 'open in new window',
        maximise: 'maximise',
        close: 'close',
    },
};

interface PaneState {
    term: Terminal;
    fitAddon: FitAddon;
    ro: ResizeObserver;
    roTimer: ReturnType<typeof setTimeout> | undefined;
    dataWs: WebSocket | null;
    resizeWs: WebSocket | null;
    instanceId: string;
    disposed: boolean;
}

export interface LayoutContainerHandle {
    addPane(role: PaneRole): void;
}

export const LayoutContainer = forwardRef<LayoutContainerHandle>(function LayoutContainer(_, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const glRef = useRef<GoldenLayout | null>(null);

    const addPane = useCallback((role: PaneRole) => {
        const gl = glRef.current;
        if (!gl) return;
        gl.addComponent(role, undefined, role === 'terminal' ? 'Terminal' : 'Neovim');
    }, []);

    useImperativeHandle(ref, () => ({ addPane }));

    useEffect(() => {
        const el = containerRef.current!;
        const paneStates = new Map<ComponentContainer, PaneState>();

        const handleBind = (
            container: ComponentContainer,
            itemConfig: ResolvedComponentItemConfig,
        ): ComponentContainer.BindableComponent => {
            const role = (itemConfig.componentType as string) as PaneRole;
            const instanceId = uuid();
            const componentEl = container.element;

            const term = new Terminal({
                cursorStyle: 'block',
                fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
                fontSize: 13,
                theme: { background: '#0d0d17' },
            });
            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(componentEl);

            const state: PaneState = {
                term, fitAddon, ro: null!, roTimer: undefined,
                dataWs: null, resizeWs: null, instanceId, disposed: false,
            };

            let lastCols = 0;
            let lastRows = 0;

            const fitAndResize = () => {
                try { fitAddon.fit(); } catch { return; }
                term.refresh(0, term.rows - 1);
                if (term.cols === lastCols && term.rows === lastRows) return;
                lastCols = term.cols; lastRows = term.rows;
                if (state.resizeWs?.readyState === WebSocket.OPEN && term.cols > 0)
                    state.resizeWs.send(`${term.cols},${term.rows}`);
            };

            const ro = new ResizeObserver(() => {
                clearTimeout(state.roTimer);
                state.roTimer = setTimeout(fitAndResize, 50);
            });
            ro.observe(componentEl);
            state.ro = ro;

            // Spawn PTY, then connect data/resize WebSockets
            ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: cwd() }).then(() => {
                if (state.disposed) return;

                const proto = location.protocol === 'https:' ? 'wss' : 'ws';
                const base = `${proto}://${location.host}/pty/${instanceId}`;
                const enc = new TextEncoder();

                const dws = new WebSocket(`${base}/data`);
                state.dataWs = dws;
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
                state.resizeWs = rws;
                rws.addEventListener('open', () => { state.resizeWs = rws; fitAndResize(); });
                rws.addEventListener('close', () => { state.resizeWs = null; });

                requestAnimationFrame(() => {
                    fitAndResize();
                    setTimeout(() => { fitAndResize(); term.focus(); }, 50);
                });
            });

            paneStates.set(container, state);
            return { component: componentEl, virtual: false };
        };

        const handleUnbind = (container: ComponentContainer): void => {
            const state = paneStates.get(container);
            if (!state) return;
            state.disposed = true;
            clearTimeout(state.roTimer);
            state.ro.disconnect();
            state.dataWs?.close();
            state.resizeWs?.close();
            state.term.dispose();
            ptyControlService.kill(state.instanceId);
            paneStates.delete(container);
        };

        const gl = new GoldenLayout(el, handleBind, handleUnbind);
        glRef.current = gl;

        // Load layout: from localStorage (structure only) or default
        let config = DEFAULT_CONFIG;
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const resolved = JSON.parse(saved);
                config = LayoutConfig.fromResolved(resolved);
            }
        } catch {
            localStorage.removeItem(STORAGE_KEY);
        }
        gl.loadLayout(config);

        // Save layout structure on beforeunload
        const onBeforeUnload = () => {
            try {
                const resolved = gl.saveLayout();
                // Strip componentState from all components to keep only structure
                const strip = (item: any) => {
                    if (item.componentState !== undefined) delete item.componentState;
                    if (item.content) item.content.forEach(strip);
                };
                strip(resolved.root);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
            } catch { /* ignore */ }
        };
        window.addEventListener('beforeunload', onBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', onBeforeUnload);
            // Clean up all pane states
            for (const state of paneStates.values()) {
                state.disposed = true;
                clearTimeout(state.roTimer);
                state.ro.disconnect();
                state.dataWs?.close();
                state.resizeWs?.close();
                state.term.dispose();
                ptyControlService.kill(state.instanceId);
            }
            paneStates.clear();
            gl.destroy();
            glRef.current = null;
        };
    }, []);

    return (
        <div
            ref={containerRef}
            style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'clip' }}
        />
    );
});
```

**Step 2: Verify it compiles**

Run: `cd client && npx webpack --mode development 2>&1 | tail -20`
Expected: successful build

**Step 3: Commit**

```bash
git add client/src/LayoutContainer.tsx
git commit -m "feat: rewrite LayoutContainer with golden-layout v2"
```

---

### Task 4: Delete XtermPane.tsx

**Files:**
- Delete: `client/src/XtermPane.tsx`

**Step 1: Delete the file**

```bash
rm client/src/XtermPane.tsx
```

**Step 2: Verify build still works**

Run: `cd client && npx webpack --mode development 2>&1 | tail -20`
Expected: successful build with no import errors

**Step 3: Commit**

```bash
git add client/src/XtermPane.tsx
git commit -m "chore: remove XtermPane — logic absorbed into LayoutContainer GL factory"
```

---

### Task 5: Build and manual test

**Step 1: Full build**

Run: `cd client && npx webpack --mode development`
Expected: successful build

**Step 2: Verify server is running**

Run: `curl -s http://localhost:3000/healthz`
Expected: `ok` or similar

**Step 3: Manual test checklist**

- Open http://localhost:3000 — should show toolbar + single Neovim tab in GL
- Neovim should be interactive (type `:version` to verify)
- Click "+ Terminal" — new terminal tab appears in the same stack
- Click "+ Neovim" — new neovim tab appears
- Drag a tab to the right side — should split horizontally
- Drag a tab to the bottom — should split vertically
- Resize splitters — panes should resize, xterm should refit
- Close a tab — pane should be removed, PTY killed
- Refresh page — layout structure should be restored (with fresh PTY instances)

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: golden-layout integration complete"
```
