# React Frontend Conversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the plain-TypeScript golden-layout+xterm frontend to a React app where React owns the entire UI including panes rendered via ReactDOM portals into golden-layout containers.

**Architecture:** `main.tsx` bootstraps with `ReactDOM.createRoot`. `<App>` renders `<Toolbar>` and `<LayoutContainer>`. Golden-layout is initialized imperatively inside a `useEffect` in `<LayoutContainer>`; when GL creates a panel container, `ReactDOM.createRoot(glContainer).render(<XtermPane .../>)` portals a React component in. `<XtermPane>` owns xterm Terminal, FitAddon, WebSockets, and ResizeObserver entirely within `useEffect` with full cleanup.

**Tech Stack:** React 18, ReactDOM, TypeScript, golden-layout v2, xterm v5, xterm-addon-fit, webpack 5, ts-loader

---

### Task 1: Add React dependencies and update tooling config

**Files:**
- Modify: `client/package.json`
- Modify: `client/tsconfig.json`
- Modify: `client/webpack.config.js`

**Step 1: Install React packages**

```bash
cd client && npm install react react-dom
npm install --save-dev @types/react @types/react-dom
```

Expected: packages installed, `package.json` updated with react and react-dom in dependencies, types in devDependencies.

**Step 2: Add JSX support to tsconfig**

In `client/tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Update webpack entry and extensions**

In `client/webpack.config.js`:
- Change `entry` from `'./src/main.ts'` to `'./src/main.tsx'`
- Add `'.tsx'` to `resolve.extensions`
- Change the ts-loader test regex from `/\.ts$/` to `/\.tsx?$/`

Final `webpack.config.js`:

```js
const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'source-map',
    entry: './src/main.tsx',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
    ],
};
```

**Step 4: Verify build still works (will fail at entry — that's expected)**

```bash
cd client && npm run build 2>&1 | head -5
```

Expected: error about missing `./src/main.tsx` — that's fine, confirms webpack picked up config changes.

**Step 5: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add client/package.json client/package-lock.json client/tsconfig.json client/webpack.config.js
git commit -m "feat(client): add react deps and update tooling for tsx"
```

---

### Task 2: Create `XtermPane` component

This is the most complex component. It owns xterm Terminal, WebSockets, FitAddon, and ResizeObserver entirely inside React hooks.

**Files:**
- Create: `client/src/XtermPane.tsx`
- Keep: `client/src/pty-control-service.ts` (unchanged)

**Step 1: Create `client/src/XtermPane.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { PaneRole } from './pty-control-service';

interface Props {
    instanceId: string;
    role: PaneRole;
}

export function XtermPane({ instanceId }: Props) {
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
```

**Step 2: No test for this component** (xterm requires real DOM; integration-only). Skip to commit.

**Step 3: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add client/src/XtermPane.tsx
git commit -m "feat(client): add XtermPane React component with xterm+ws lifecycle"
```

---

### Task 3: Create `Toolbar` component

**Files:**
- Create: `client/src/Toolbar.tsx`

**Step 1: Create `client/src/Toolbar.tsx`**

```tsx
interface Props {
    onAdd: (role: 'neovim' | 'terminal') => void;
}

export function Toolbar({ onAdd }: Props) {
    return (
        <div className="mineo-toolbar">
            <button className="mineo-toolbar-btn" onClick={() => onAdd('neovim')}>+ Neovim</button>
            <button className="mineo-toolbar-btn" onClick={() => onAdd('terminal')}>+ Terminal</button>
        </div>
    );
}
```

**Step 2: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add client/src/Toolbar.tsx
git commit -m "feat(client): add Toolbar React component"
```

---

### Task 4: Create `LayoutContainer` component

This component holds the golden-layout instance. When GL creates a panel, it portals an `<XtermPane>` into the container element via `ReactDOM.createRoot`.

**Files:**
- Create: `client/src/LayoutContainer.tsx`

**Step 1: Create `client/src/LayoutContainer.tsx`**

```tsx
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoldenLayout, ComponentContainer, LayoutConfig } from 'golden-layout';
import { XtermPane } from './XtermPane';
import { ptyControlService, PaneRole } from './pty-control-service';

const STORAGE_KEY = 'mineo.layout';

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

function defaultLayout(): LayoutConfig {
    return {
        root: {
            type: 'stack',
            content: [{
                type: 'component',
                componentType: 'neovim',
                componentState: { instanceId: uuid(), role: 'neovim' as PaneRole },
                title: 'Neovim',
            }],
        },
    };
}

export interface LayoutContainerHandle {
    addPane(role: PaneRole): void;
}

export const LayoutContainer = forwardRef<LayoutContainerHandle>(function LayoutContainer(_, ref) {
    const divRef = useRef<HTMLDivElement>(null);
    const glRef = useRef<GoldenLayout | null>(null);

    useImperativeHandle(ref, () => ({
        addPane(role: PaneRole) {
            glRef.current?.addComponent(role, { instanceId: uuid(), role }, role === 'terminal' ? 'Terminal' : 'Neovim');
        },
    }));

    useEffect(() => {
        const container = divRef.current!;
        const gl = new GoldenLayout(container);
        glRef.current = gl;

        const mount = (glc: ComponentContainer, state: unknown) => {
            const { instanceId, role } = state as { instanceId: string; role: PaneRole };
            ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: cwd() });

            const root = createRoot(glc.element);
            root.render(<XtermPane instanceId={instanceId} role={role} />);

            glc.on('destroy', () => {
                ptyControlService.kill(instanceId);
                root.unmount();
            });
        };

        gl.registerComponentFactoryFunction('neovim', mount);
        gl.registerComponentFactoryFunction('terminal', mount);

        const saved = (() => {
            try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) as LayoutConfig : null; } catch { return null; }
        })();

        try { gl.loadLayout(saved ?? defaultLayout()); }
        catch { gl.loadLayout(defaultLayout()); }

        gl.on('stateChanged', () => {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gl.saveLayout())); } catch { /* ignore */ }
        });

        const onResize = () => gl.updateSize(container.offsetWidth, container.offsetHeight);
        window.addEventListener('resize', onResize);

        return () => {
            window.removeEventListener('resize', onResize);
            gl.destroy();
            glRef.current = null;
        };
    }, []);

    return <div ref={divRef} style={{ flex: 1, minHeight: 0 }} />;
});
```

**Step 2: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add client/src/LayoutContainer.tsx
git commit -m "feat(client): add LayoutContainer React component wrapping golden-layout"
```

---

### Task 5: Create `App` component and `main.tsx` entry point

**Files:**
- Create: `client/src/App.tsx`
- Create: `client/src/main.tsx`
- Delete: `client/src/main.ts`
- Delete: `client/src/nvim-widget.ts`
- Delete: `client/src/layout-manager.ts`

**Step 1: Create `client/src/App.tsx`**

```tsx
import { useRef } from 'react';
import { Toolbar } from './Toolbar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';
import type { PaneRole } from './pty-control-service';

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);

    const handleAdd = (role: PaneRole) => layoutRef.current?.addPane(role);

    return (
        <>
            <Toolbar onAdd={handleAdd} />
            <LayoutContainer ref={layoutRef} />
        </>
    );
}
```

**Step 2: Create `client/src/main.tsx`**

```tsx
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './style/main.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('mineo-root')!;
createRoot(rootEl).render(<App />);
```

**Step 3: Delete old files**

```bash
cd /Users/nhath/Documents/projects/mineo
rm client/src/main.ts client/src/nvim-widget.ts client/src/layout-manager.ts
```

**Step 4: Update `client/dist/index.html` — remove toolbar div (React owns it now)**

The `<div id="mineo-toolbar">` in `client/dist/index.html` is no longer needed — `<App>` renders `<Toolbar>` directly inside `#mineo-root`. Also update CSS: `#mineo-root` must be a flex column container so `<Toolbar>` and `<LayoutContainer>` stack correctly.

Edit `client/dist/index.html` to remove the toolbar div:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Mineo</title>
  <link rel="stylesheet" href="./bundle.css">
</head>
<body>
  <div id="mineo-root"></div>
  <script src="./bundle.js"></script>
</body>
</html>
```

**Step 5: Update `client/src/style/main.css`**

`#mineo-root` must be a flex column so React-rendered toolbar + layout container stack vertically:

```css
*, *::before, *::after { box-sizing: border-box; }

html, body {
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    background: #0d0d17;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

#mineo-root {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.nvim-widget { width: 100%; height: 100%; }
.xterm { height: 100%; padding: 4px; }
.xterm-viewport { overflow-y: hidden !important; }

.mineo-toolbar {
    height: 36px;
    background: #12121f;
    display: flex;
    align-items: center;
    padding: 0 8px;
    gap: 6px;
    border-bottom: 1px solid #2a2a3e;
}
.mineo-toolbar-btn {
    padding: 4px 10px;
    border: 1px solid #333;
    border-radius: 4px;
    background: #1a1a2e;
    color: #ccc;
    font-size: 12px;
    cursor: pointer;
}
.mineo-toolbar-btn:hover { background: #252540; color: #fff; }
```

**Step 6: Build and verify**

```bash
cd client && npm run build 2>&1 | tail -5
```

Expected: `webpack 5.x.x compiled successfully`

**Step 7: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add client/src/App.tsx client/src/main.tsx client/src/style/main.css
git rm client/src/main.ts client/src/nvim-widget.ts client/src/layout-manager.ts
git commit -m "feat(client): convert frontend to React — App, main.tsx, delete old TS files"
```

---

### Task 6: Smoke test end-to-end

**Step 1: Start the server**

```bash
cd /Users/nhath/Documents/projects/mineo && npm run start:new
```

**Step 2: Open browser**

Navigate to `http://localhost:3000` (or whatever port the server uses).

**Step 3: Verify**

- Page loads without console errors
- Toolbar shows "+ Neovim" and "+ Terminal" buttons
- Clicking "+ Neovim" opens a golden-layout panel with a working xterm terminal running neovim
- Clicking "+ Terminal" opens a golden-layout panel with a shell
- Panels can be dragged/resized
- Refreshing the page restores the saved layout

**Step 4: Commit if any minor fixes were needed during smoke test**

```bash
git add -p
git commit -m "fix(client): smoke test fixes"
```
