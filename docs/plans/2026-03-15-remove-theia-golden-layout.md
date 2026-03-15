# Remove Theia — Golden Layout Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the entire Theia/Lumino frontend with a minimal vanilla TypeScript + golden-layout + xterm.js stack, while keeping the existing Node/Express backend untouched.

**Architecture:**
- New `app/src/browser/` is a clean TypeScript SPA — no Theia, no InversifyJS, no Monaco.
- golden-layout manages the tab/pane layout (replaces Lumino + TilingContainer).
- `NvimWidget` (xterm.js + WebSocket channels) is the only pane content type.
- Layout persistence stays in `localStorage`. PTY lifecycle stays over WebSocket `/services/pty/control`.
- Backend (`app/src/node/`) is **not touched at all**.

**Tech Stack:** TypeScript, golden-layout v2, xterm.js, xterm-addon-fit, Webpack, plain CSS

---

## Task 1: Scaffold new package.json and remove Theia deps

**Files:**
- Modify: `app/package.json`

**Step 1: Read current `app/package.json`**

**Step 2: Replace dependencies section**

Remove all `@theia/*`, `monaco-languageclient`, `vscode-*`, `web-tree-sitter` from `dependencies`.

Keep or add only:
```json
"dependencies": {
  "golden-layout": "^2.6.0",
  "xterm": "^5.3.0",
  "xterm-addon-fit": "^0.8.0"
}
```

Remove from `devDependencies`:
- `@theia/cli`

Keep/add in `devDependencies`:
```json
"devDependencies": {
  "@types/node": "^18.0.0",
  "css-loader": "^6.0.0",
  "mini-css-extract-plugin": "^2.0.0",
  "style-loader": "^3.0.0",
  "ts-loader": "^9.0.0",
  "typescript": "^5.0.0",
  "webpack": "^5.0.0",
  "webpack-cli": "^5.0.0"
}
```

**Step 3: Replace `scripts` section**

```json
"scripts": {
  "build": "tsc --noEmit && webpack --config webpack.frontend.js",
  "build:backend": "tsc -p tsconfig.node.json",
  "watch": "webpack --config webpack.frontend.js --watch"
}
```

**Step 4: Run `npm install` in the app directory**
```bash
cd /Users/nhath/Documents/projects/mineo/app && npm install
```

**Step 5: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/package.json app/package-lock.json
git commit -m "chore: replace Theia deps with golden-layout + xterm in app/package.json"
```

---

## Task 2: New webpack config for frontend

**Files:**
- Create: `app/webpack.frontend.js`

**Step 1: Write the new webpack config**

```javascript
// app/webpack.frontend.js
const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'source-map',
    entry: './src/browser/main.ts',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'lib/frontend'),
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
            {
                // golden-layout ships ESM — let webpack handle it
                test: /\.js$/,
                include: /node_modules\/golden-layout/,
                type: 'javascript/auto',
            },
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
    ],
};
```

**Step 2: Update `app/src-gen/frontend/index.html`** to load the new bundle:

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

**Step 3: Write new `app/tsconfig.json`** for browser code:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./lib",
    "baseUrl": "."
  },
  "include": ["src/browser/**/*"],
  "exclude": ["node_modules", "lib"]
}
```

**Step 4: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/webpack.frontend.js app/src-gen/frontend/index.html app/tsconfig.json
git commit -m "chore: add new webpack frontend config and update index.html for golden-layout SPA"
```

---

## Task 3: PTY control service (plain TypeScript)

**Files:**
- Create: `app/src/browser/pty-control-service.ts`

No Theia, no InversifyJS. Plain singleton class over WebSocket.

**Step 1: Read existing `app/src/common/pty-protocol.ts`** to get the message types.

**Step 2: Write the new service**

```typescript
// app/src/browser/pty-control-service.ts

const CONTROL_PATH = '/services/pty/control';

export interface SpawnOptions {
    instanceId: string;
    role: 'neovim' | 'terminal';
    cols: number;
    rows: number;
    cwd?: string;
}

export class PtyControlService {
    private ws: WebSocket | null = null;
    private queue: string[] = [];

    constructor() {
        this.connect();
    }

    private connect(): void {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}${CONTROL_PATH}`;
        this.ws = new WebSocket(url);
        this.ws.addEventListener('open', () => {
            for (const msg of this.queue) this.ws!.send(msg);
            this.queue = [];
        });
        this.ws.addEventListener('close', () => {
            setTimeout(() => this.connect(), 2000);
        });
    }

    private send(msg: object): void {
        const str = JSON.stringify(msg);
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(str);
        } else {
            this.queue.push(str);
        }
    }

    spawn(opts: SpawnOptions): void {
        this.send({ type: 'spawn', ...opts });
    }

    kill(instanceId: string): void {
        this.send({ type: 'kill', instanceId });
    }
}

export const ptyControlService = new PtyControlService();
```

**Step 3: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/pty-control-service.ts
git commit -m "feat(browser): add plain PtyControlService singleton (no Theia)"
```

---

## Task 4: NvimWidget (xterm.js pane, no Theia)

**Files:**
- Create: `app/src/browser/nvim-widget.ts`

Plain class — no BaseWidget, no InversifyJS, no Theia messaging. Uses native WebSocket.

**Step 1: Write NvimWidget**

```typescript
// app/src/browser/nvim-widget.ts
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

export class NvimWidget {
    readonly instanceId: string;
    readonly role: 'neovim' | 'terminal';
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

    constructor(instanceId: string, role: 'neovim' | 'terminal') {
        this.instanceId = instanceId;
        this.role = role;
        this.element = document.createElement('div');
        this.element.className = 'nvim-widget';
        this.element.style.cssText = 'width:100%;height:100%;overflow:hidden;';

        this.term = new Terminal({
            cursorStyle: 'block',
            cursorBlink: false,
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 13,
            lineHeight: 1.0,
            theme: { background: '#0d0d17' },
        });
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);

        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        this.ro = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.fitAndResize(), 50);
        });
        this.ro.observe(this.element);
    }

    attach(): void {
        if (!this.termOpened) {
            this.term.open(this.element);
            this.termOpened = true;
        }
        requestAnimationFrame(() => {
            this.fitAndResize();
            setTimeout(() => {
                this.fitAndResize();
                this.term.refresh(0, this.term.rows - 1);
                if (this.dataWs?.readyState === WebSocket.OPEN) {
                    this.dataWs.send(new Uint8Array([0x0c])); // Ctrl-L redraw
                }
                this.term.focus();
            }, 50);
        });
    }

    connectChannels(): void {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const base = `${proto}://${location.host}`;

        // Data channel
        const dataWs = new WebSocket(`${base}/pty/${this.instanceId}/data`);
        dataWs.binaryType = 'arraybuffer';
        dataWs.addEventListener('open', () => { this.dataWs = dataWs; });
        dataWs.addEventListener('message', (e) => {
            const data = e.data instanceof ArrayBuffer
                ? new Uint8Array(e.data)
                : new TextEncoder().encode(e.data as string);
            this.term.write(data);
        });
        dataWs.addEventListener('close', () => {
            this.dataWs = null;
            this._onExit?.();
        });

        const enc = new TextEncoder();
        this.term.onData(data => {
            if (dataWs.readyState === WebSocket.OPEN) dataWs.send(enc.encode(data));
        });
        this.term.onBinary(data => {
            const bytes = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
            if (dataWs.readyState === WebSocket.OPEN) dataWs.send(bytes);
        });

        // Resize channel
        const resizeWs = new WebSocket(`${base}/pty/${this.instanceId}/resize`);
        resizeWs.addEventListener('open', () => {
            this.resizeWs = resizeWs;
            this.sendResize();
        });
        resizeWs.addEventListener('close', () => { this.resizeWs = null; });
    }

    onExit(cb: () => void): void { this._onExit = cb; }

    focus(): void { this.term.focus(); }

    fitAndResize(): void {
        if (!this.termOpened) return;
        try { this.fitAddon.fit(); } catch { return; }
        this.term.refresh(0, this.term.rows - 1);
        if (this.term.cols === this.lastCols && this.term.rows === this.lastRows) return;
        this.lastCols = this.term.cols;
        this.lastRows = this.term.rows;
        this.sendResize();
    }

    private sendResize(): void {
        if (this.resizeWs?.readyState === WebSocket.OPEN && this.term.cols > 0) {
            this.resizeWs.send(`${this.term.cols},${this.term.rows}`);
        }
    }

    dispose(): void {
        this.ro.disconnect();
        this.dataWs?.close();
        this.resizeWs?.close();
        this.term.dispose();
    }
}
```

**Step 2: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/nvim-widget.ts
git commit -m "feat(browser): add plain NvimWidget (xterm.js, no Theia)"
```

---

## Task 5: Layout manager (golden-layout wrapper)

**Files:**
- Create: `app/src/browser/layout-manager.ts`

Wraps golden-layout. Manages pane creation, persistence, tab operations.

**Step 1: Write LayoutManager**

```typescript
// app/src/browser/layout-manager.ts
import { GoldenLayout, ComponentContainer, LayoutConfig } from 'golden-layout';
import { NvimWidget } from './nvim-widget';
import { ptyControlService } from './pty-control-service';

const STORAGE_KEY = 'mineo.golden-layout';

// Pool: instanceId → NvimWidget (prevents black screen on drag)
const widgetPool = new Map<string, NvimWidget>();

function uuid(): string {
    return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function getCwd(): string | undefined {
    const hash = location.hash.replace(/^#/, '');
    return hash.startsWith('/') ? hash : undefined;
}

function createWidget(instanceId: string, role: 'neovim' | 'terminal'): NvimWidget {
    let widget = widgetPool.get(instanceId);
    if (!widget) {
        widget = new NvimWidget(instanceId, role);
        widgetPool.set(instanceId, widget);
        ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: getCwd() });
        widget.connectChannels();
        widget.onExit(() => {
            widgetPool.delete(instanceId);
        });
    }
    return widget;
}

function defaultConfig(): LayoutConfig {
    return {
        root: {
            type: 'stack',
            content: [{
                type: 'component',
                componentType: 'neovim',
                componentState: { instanceId: uuid(), role: 'neovim' },
                title: 'Neovim',
            }],
        },
    };
}

export class LayoutManager {
    private gl: GoldenLayout;

    constructor(container: HTMLElement) {
        this.gl = new GoldenLayout(container);

        this.gl.registerComponentFactoryFunction('neovim', (glContainer, state) => {
            this.mountWidget(glContainer, state as { instanceId: string; role: 'neovim' | 'terminal' });
        });
        this.gl.registerComponentFactoryFunction('terminal', (glContainer, state) => {
            this.mountWidget(glContainer, state as { instanceId: string; role: 'neovim' | 'terminal' });
        });

        const saved = this.loadConfig();
        this.gl.loadLayout(saved ?? defaultConfig());

        // Save on any layout change
        this.gl.on('stateChanged', () => this.saveConfig());

        window.addEventListener('resize', () => this.gl.updateSize());
    }

    private mountWidget(glContainer: ComponentContainer, state: { instanceId: string; role: 'neovim' | 'terminal' }): void {
        const widget = createWidget(state.instanceId, state.role);
        glContainer.element.appendChild(widget.element);
        widget.attach();

        glContainer.on('resize', () => widget.fitAndResize());
        glContainer.on('shown', () => { widget.attach(); widget.fitAndResize(); });
        glContainer.on('destroy', () => {
            widgetPool.delete(state.instanceId);
            ptyControlService.kill(state.instanceId);
            widget.dispose();
        });
    }

    addPane(role: 'neovim' | 'terminal' = 'neovim'): void {
        const instanceId = uuid();
        const componentType = role;
        this.gl.addComponent(componentType, { instanceId, role }, role === 'neovim' ? 'Neovim' : 'Terminal');
    }

    private saveConfig(): void {
        try {
            const config = this.gl.saveLayout();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch { /* ignore */ }
    }

    private loadConfig(): LayoutConfig | null {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) as LayoutConfig : null;
        } catch {
            return null;
        }
    }
}
```

**Step 2: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/layout-manager.ts
git commit -m "feat(browser): add LayoutManager wrapping golden-layout"
```

---

## Task 6: Main entry point and CSS

**Files:**
- Create: `app/src/browser/main.ts`
- Create: `app/src/browser/style/main.css`

**Step 1: Write main.ts**

```typescript
// app/src/browser/main.ts
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './style/main.css';
import { LayoutManager } from './layout-manager';

document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('mineo-root')!;
    root.style.cssText = 'width:100vw;height:100vh;overflow:hidden;';

    const manager = new LayoutManager(root);

    // "+" button to add a new neovim pane
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.className = 'mineo-add-btn';
    addBtn.title = 'New pane (neovim)';
    addBtn.addEventListener('click', () => manager.addPane('neovim'));
    document.body.appendChild(addBtn);
});
```

**Step 2: Write main.css**

```css
/* app/src/browser/style/main.css */
*, *::before, *::after { box-sizing: border-box; }

html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #0d0d17;
    overflow: hidden;
    font-family: system-ui, sans-serif;
}

#mineo-root {
    width: 100vw;
    height: 100vh;
}

.nvim-widget {
    width: 100%;
    height: 100%;
    overflow: hidden;
}

/* xterm.js overrides */
.xterm {
    height: 100%;
    padding: 4px;
}
.xterm-viewport {
    overflow-y: hidden !important;
}

/* Add pane button */
.mineo-add-btn {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: #4a9eff;
    color: white;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    z-index: 1000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.mineo-add-btn:hover { background: #6ab0ff; }
```

**Step 3: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/main.ts app/src/browser/style/main.css
git commit -m "feat(browser): add main entry point and base CSS for golden-layout SPA"
```

---

## Task 7: Wire backend to serve new frontend

The existing backend uses Theia's `MineoBASServer` to serve `lib/frontend/`. We need to make sure:
1. The new `bundle.js` and `bundle.css` land in `app/lib/frontend/`
2. The backend serves them (it already serves that directory statically)
3. The Theia-generated `gen-webpack.config.js` is not used anymore

**Step 1: Read `app/src/node/mineo-backend-module.ts`** to check how static files are served.

**Step 2: Read `app/src/node/neovim-pty-contribution.ts`** to check how PTY WebSocket channels are set up — confirm `/pty/<instanceId>/data` and `/pty/<instanceId>/resize` paths work as plain WebSocket (not Theia channel).

**Step 3: Check if the backend still needs Theia**

The backend uses `@theia/core/lib/node` for its server infrastructure (Express, WebSocket). This cannot be removed without rewriting the backend. Since the task says backend is untouched, just verify the backend still builds independently.

Run: `grep -r "theia" /Users/nhath/Documents/projects/mineo/app/src/node/ | grep "import" | head -20`

**Step 4: Build just the frontend**

```bash
cd /Users/nhath/Documents/projects/mineo/app && npx webpack --config webpack.frontend.js
```

Expected: `bundle.js` and `bundle.css` appear in `app/lib/frontend/`.

**Step 5: Verify index.html is in place**

```bash
ls /Users/nhath/Documents/projects/mineo/app/lib/frontend/
```

Expected: `index.html`, `bundle.js`, `bundle.css`.

If `index.html` is missing, copy it:
```bash
cp /Users/nhath/Documents/projects/mineo/app/src-gen/frontend/index.html /Users/nhath/Documents/projects/mineo/app/lib/frontend/index.html
```

**Step 6: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add app/lib/frontend/index.html
git commit -m "chore: ensure index.html references new bundle.css in lib/frontend"
```

---

## Task 8: Verify PTY WebSocket paths match backend

The new `NvimWidget` connects to:
- `ws://host/pty/<instanceId>/data`
- `ws://host/pty/<instanceId>/resize`

And `PtyControlService` connects to:
- `ws://host/services/pty/control`

**Step 1: Read `app/src/node/neovim-pty-contribution.ts`** and `app/src/common/pty-protocol.ts` to confirm backend path patterns.

**Step 2: If paths differ**, update `nvim-widget.ts` and `pty-control-service.ts` to use the correct paths from `pty-protocol.ts`.

**Step 3: Read `app/src/node/mineo-backend-module.ts`** to confirm `MineoBASServer` still serves `/api/*` and static files from `lib/frontend/`.

**Step 4: Smoke test**

Start the backend:
```bash
cd /Users/nhath/Documents/projects/mineo && node app/lib/node/backend-main.js
```

Open `http://localhost:3000` — verify the golden-layout UI loads (not the old Theia UI).

**Step 5: Commit any path fixes**
```bash
git add app/src/browser/nvim-widget.ts app/src/browser/pty-control-service.ts
git commit -m "fix(browser): align WebSocket paths with backend PTY contribution"
```

---

## Summary

| Task | What it does | Risk |
|------|-------------|------|
| 1 | Replace package.json deps | Medium — npm install needed |
| 2 | New webpack config | Low |
| 3 | PtyControlService (plain) | Low |
| 4 | NvimWidget (plain xterm.js) | Low |
| 5 | LayoutManager (golden-layout) | Medium — golden-layout API |
| 6 | main.ts + CSS | Low |
| 7 | Wire backend serving | Low — backend untouched |
| 8 | Verify PTY paths | Low — read-only check |

Execute tasks 1 → 8 in order. Tasks 3–6 can be done in parallel (no interdependencies between them), but all must be done before task 7.

## What is NOT in this plan (future work)
- Settings panel (font size, theme)
- Touch toolbar (mobile)
- RAM status bar
- Tab rename
- LSP support (requires language server bridge, add later if needed)
- Auth UI (backend handles it; frontend just loads index.html after login)
