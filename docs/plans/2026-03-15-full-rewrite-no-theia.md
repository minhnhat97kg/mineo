# Full Rewrite — Remove Theia Completely

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Theia entirely. New stack: plain Express+ws backend, golden-layout+xterm.js frontend. All existing PTY/auth/config/LSP business logic is kept.

**Architecture:**
- **Backend:** Express + `ws` library. No Theia DI. Plain singletons. Same API routes + WebSocket paths as before.
- **Frontend:** TypeScript SPA. golden-layout manages panes. xterm.js renders Neovim/terminal. No Monaco, no InversifyJS.
- **Shared:** `pty-protocol.ts` and `layout-types.ts` stay as-is (pure type definitions, no Theia imports).

**New project layout:**
```
mineo/
  server/           ← new backend (replaces app/src/node + Theia)
    src/
      config.ts
      secret.ts
      auth.ts
      nvim-ready.ts
      pty-manager.ts
      lsp-server-manager.ts
      ws-pty.ts        ← WebSocket PTY channels (replaces neovim-pty-contribution.ts)
      api.ts           ← all HTTP API routes
      server.ts        ← Express + ws entry point
    package.json
    tsconfig.json
  client/           ← new frontend (replaces app/src/browser)
    src/
      pty-control-service.ts
      nvim-widget.ts
      layout-manager.ts
      main.ts
      style/main.css
    package.json
    tsconfig.json
    webpack.config.js
  config.json       ← existing, untouched
  nvim-config/      ← existing, untouched
```

**Tech Stack:**
- Backend: Node.js, TypeScript, Express, ws, node-pty, express-session, memorystore
- Frontend: TypeScript, golden-layout v2, xterm.js v5, xterm-addon-fit, Webpack 5

---

## Task 1: Bootstrap server/ package

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`

**Step 1: Create `server/package.json`**

```json
{
  "name": "mineo-server",
  "version": "1.0.0",
  "private": true,
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/server.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "cookie": "^0.6.0",
    "express": "^4.19.0",
    "express-session": "^1.18.0",
    "memorystore": "^1.6.7",
    "node-pty": "^1.0.0",
    "ws": "^8.17.0"
  },
  "devDependencies": {
    "@types/cookie": "^0.6.0",
    "@types/express": "^4.17.21",
    "@types/express-session": "^1.17.10",
    "@types/node": "^18.0.0",
    "@types/ws": "^8.5.10",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Install deps**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npm install
```

**Step 4: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/package.json server/tsconfig.json server/package-lock.json
git commit -m "chore(server): bootstrap new plain Express+ws server package"
```

---

## Task 2: Port config.ts, secret.ts, nvim-ready.ts (zero Theia deps)

These three files have no Theia imports — copy them directly.

**Files:**
- Create: `server/src/config.ts`
- Create: `server/src/secret.ts`
- Create: `server/src/nvim-ready.ts`

**Step 1: Copy `app/src/node/config.ts` → `server/src/config.ts`**

Read the original and write it identically. The only change: update the default CONFIG_PATH to `path.join(__dirname, '../../config.json')` so it finds the config at the repo root.

The key exported items to preserve:
- `MineoCfg` interface
- `NvimConfigMode` type
- `loadConfig(configPath)` function
- `saveConfig(configPath, patch)` function
- `saveNvimConfig(configPath, patch)` function

**Step 2: Copy `app/src/node/secret.ts` → `server/src/secret.ts`**

Read the original and copy verbatim. No Theia deps.

**Step 3: Copy `app/src/node/nvim-ready.ts` → `server/src/nvim-ready.ts`**

Read the original and copy verbatim. No Theia deps.

**Step 4: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/config.ts server/src/secret.ts server/src/nvim-ready.ts
git commit -m "feat(server): port config, secret, nvim-ready from app/src/node"
```

---

## Task 3: Port auth.ts (replace Theia types with plain Express/ws)

**Files:**
- Create: `server/src/auth.ts`

The original `auth.ts` uses `Application` from `@theia/core/shared/express`. Replace with `express.Application` from the `express` package. The WebSocket interceptor uses `http.Server` — keep as-is.

**Step 1: Read `app/src/node/auth.ts` carefully**

**Step 2: Write `server/src/auth.ts`**

Replace Theia imports:
```typescript
// OLD (Theia)
import { Application } from '@theia/core/shared/express';
// NEW
import { Application } from 'express';
```

Replace Theia WebSocket types: the original uses Theia's `MaybePromise` and channel types. The new version uses plain `http.Server` and `ws.WebSocketServer`:

```typescript
import * as http from 'http';
import * as express from 'express';
import * as session from 'express-session';
import MemoryStore from 'memorystore';
import * as cookie from 'cookie';

const MemStore = MemoryStore(session);

export interface AuthOptions {
    password: string;
    secret: string;
    app: express.Application;
    server: http.Server;
}

export function registerAuth(opts: AuthOptions): session.Store | null {
    if (!opts.password) return null;

    const store = new MemStore({ checkPeriod: 86400000 });

    opts.app.use(session({
        secret: opts.secret,
        resave: false,
        saveUninitialized: false,
        store,
        cookie: { httpOnly: true, sameSite: 'lax' },
    }));

    opts.app.get('/login', (_req, res) => {
        res.send(LOGIN_HTML);
    });

    opts.app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
        if (req.body?.password === opts.password) {
            (req.session as any).authenticated = true;
            res.redirect('/');
        } else {
            res.send(LOGIN_HTML.replace('</form>', '<p style="color:red">Wrong password</p></form>'));
        }
    });

    opts.app.use((req, res, next) => {
        if (req.path === '/healthz' || req.path.startsWith('/login')) return next();
        if ((req.session as any).authenticated) return next();
        res.redirect('/login');
    });

    return store;
}

export function registerAuthWS(opts: { password: string; server: http.Server; store: session.Store }): void {
    if (!opts.password || !opts.store) return;

    opts.server.on('upgrade', (req, socket, head) => {
        const cookies = cookie.parse(req.headers.cookie ?? '');
        const sid = cookies['connect.sid'];
        if (!sid) { socket.destroy(); return; }

        const rawSid = decodeURIComponent(sid).replace(/^s:/, '').split('.')[0];
        opts.store.get(rawSid, (err, sess) => {
            if (err || !(sess as any)?.authenticated) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
            }
            // else: let the upgrade proceed naturally
        });
    });
}

const LOGIN_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Mineo Login</title>
<style>body{background:#0d0d17;color:#ccc;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
form{background:#1a1a2e;padding:2rem;border-radius:8px;display:flex;flex-direction:column;gap:1rem;min-width:280px}
input,button{padding:.6rem;border-radius:4px;border:1px solid #333;background:#0d0d17;color:#ccc;font-size:1rem}
button{background:#4a9eff;border:none;cursor:pointer;color:#fff}</style></head>
<body><form method="POST" action="/login">
<h2 style="margin:0">Mineo</h2>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Login</button>
</form></body></html>`;
```

**Step 3: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/auth.ts
git commit -m "feat(server): port auth.ts with plain express-session (no Theia)"
```

---

## Task 4: Port pty-manager.ts (replace Theia imports)

**Files:**
- Create: `server/src/pty-manager.ts`

The original has no Theia *runtime* deps — it uses `node-pty`, `child_process`, `net`, `os`, `path`. The only Theia import is `injectable` decorator which we remove.

**Step 1: Read `app/src/node/pty-manager.ts` completely**

**Step 2: Write `server/src/pty-manager.ts`**

Remove `@injectable()` decorator and `import { injectable } from '@theia/core/shared/inversify'`.
Keep all logic identical: `spawn()`, `write()`, `resize()`, `onData()`, `kill()`, `getPrimarySocketPath()`, `getSocketPath()`, `getNvimBin()`, `nvimConfigEnv()`, RGB translation.

Export a singleton instance at the bottom:
```typescript
export const ptyManager = new PtyManager();
```

**Step 3: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/pty-manager.ts
git commit -m "feat(server): port pty-manager.ts, remove @injectable, export singleton"
```

---

## Task 5: Write ws-pty.ts (WebSocket PTY channels, replaces neovim-pty-contribution.ts)

**Files:**
- Create: `server/src/ws-pty.ts`

Replaces the Theia MessagingService/Channel abstraction with plain `ws.WebSocketServer` route handlers. Same paths:
- `ws://host/services/pty/control` — spawn/kill
- `ws://host/pty/:id/data` — raw I/O
- `ws://host/pty/:id/resize` — terminal resize
- `ws://host/pty/:id/buffer-watch` — nvim current file polling

**Step 1: Write `server/src/ws-pty.ts`**

```typescript
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { ptyManager } from './pty-manager';

export function attachPtyWebSockets(server: http.Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '', `http://${req.headers.host}`).pathname;

        // Control channel: spawn / kill
        if (pathname === '/services/pty/control') {
            wss.handleUpgrade(req, socket, head, (ws) => handleControl(ws));
            return;
        }

        // Per-instance channels: /pty/:id/data|resize|buffer-watch
        const m = pathname.match(/^\/pty\/([^/]+)\/(data|resize|buffer-watch)$/);
        if (m) {
            const [, instanceId, channel] = m;
            wss.handleUpgrade(req, socket, head, (ws) => {
                if (channel === 'data') handleData(ws, instanceId);
                else if (channel === 'resize') handleResize(ws, instanceId);
                else if (channel === 'buffer-watch') handleBufferWatch(ws, instanceId);
            });
            return;
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
        } catch { /* ignore malformed */ }
    });
}

function handleData(ws: WebSocket, instanceId: string): void {
    // PTY → client
    const unsub = ptyManager.onData(instanceId, (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    // client → PTY
    ws.on('message', (raw) => {
        const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
        ptyManager.write(instanceId, data);
    });

    ws.on('close', () => unsub());
}

function handleResize(ws: WebSocket, instanceId: string): void {
    ws.on('message', (raw) => {
        const text = raw.toString();
        const [cols, rows] = text.split(',').map(Number);
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
            if (file && file !== last) {
                last = file;
                ws.send(file);
            }
        } catch { /* nvim not ready */ }
        finally { inFlight = false; }
    }, 500);
    ws.on('close', () => clearInterval(interval));
}
```

**Step 2: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/ws-pty.ts
git commit -m "feat(server): add ws-pty WebSocket PTY channels (no Theia MessagingService)"
```

---

## Task 6: Write api.ts (HTTP API routes)

**Files:**
- Create: `server/src/api.ts`

All API routes from `mineo-backend-module.ts` — no Theia.

**Step 1: Read `app/src/node/mineo-backend-module.ts` to get all route handlers**

**Step 2: Write `server/src/api.ts`**

```typescript
import * as express from 'express';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, saveNvimConfig, MineoCfg } from './config';
import { ptyManager } from './pty-manager';
import { checkNvimReady } from './nvim-ready';
import { execFile } from 'child_process';

const CONFIG_PATH = path.join(__dirname, '../../config.json');

export function registerApiRoutes(app: express.Application, cfg: MineoCfg): void {

    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });

    app.get('/api/workspace', (_req, res) => {
        res.json({ workspace: cfg.workspace });
    });

    app.get('/api/config', (_req, res) => {
        res.json({
            workspace: cfg.workspace,
            hasPassword: !!cfg.password,
            password: cfg.password ? '••••••••' : '',
        });
    });

    app.post('/api/config', express.json(), (req, res) => {
        saveConfig(CONFIG_PATH, req.body);
        Object.assign(cfg, loadConfig(CONFIG_PATH));
        res.json({ ok: true });
    });

    app.get('/api/nvim-ready', async (_req, res) => {
        const sockPath = ptyManager.getPrimarySocketPath();
        if (!sockPath) return res.json({ ready: false });
        const ready = await checkNvimReady(sockPath);
        res.json({ ready });
    });

    app.get('/api/metrics', (_req, res) => {
        const appMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const totalGB = +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        res.json({ appMB, totalGB });
    });

    app.get('/api/nvim-open', async (req, res) => {
        const file = req.query.file as string;
        const instanceId = req.query.instanceId as string | undefined;
        if (!file || !path.isAbsolute(file) || file.includes('..')) {
            return res.status(400).json({ error: 'invalid path' });
        }

        const sockPath = instanceId
            ? ptyManager.getSocketPath(instanceId)
            : ptyManager.getPrimarySocketPath();
        if (!sockPath) return res.status(503).json({ error: 'no editor' });

        const nvimBin = ptyManager.getNvimBin();
        const deadline = Date.now() + 10000;

        const tryOpen = (): Promise<void> => new Promise((resolve, reject) => {
            execFile(nvimBin, ['--server', sockPath, '--remote', file], { timeout: 2000 }, (err) => {
                if (err && Date.now() < deadline) {
                    setTimeout(() => tryOpen().then(resolve).catch(reject), 500);
                } else if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        try {
            await tryOpen();
            res.json({ ok: true });
        } catch {
            res.status(503).json({ error: 'nvim not ready' });
        }
    });

    app.get('/api/nvim-config', (_req, res) => {
        const bundledConfigDir = path.join(__dirname, '../../nvim-config');
        res.json({ ...cfg.nvim, bundledConfigDir });
    });

    app.post('/api/nvim-config', express.json(), (req, res) => {
        saveNvimConfig(CONFIG_PATH, req.body);
        Object.assign(cfg, loadConfig(CONFIG_PATH));
        ptyManager.reloadConfig(cfg);
        res.json({ ok: true });
    });

    app.get('/api/nvim-config-dir', (_req, res) => {
        const bundledConfigDir = path.join(__dirname, '../../nvim-config');
        let configDir: string;
        switch (cfg.nvim.configMode) {
            case 'bundled': configDir = bundledConfigDir; break;
            case 'custom': configDir = cfg.nvim.configDir; break;
            default: configDir = path.join(os.homedir(), '.config', 'nvim');
        }
        res.json({ configDir });
    });
}
```

**Step 3: Add `reloadConfig` method to `pty-manager.ts`** (if not already there):
```typescript
reloadConfig(cfg: MineoCfg): void {
    this._cfg = cfg;
}
```

**Step 4: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/api.ts server/src/pty-manager.ts
git commit -m "feat(server): add HTTP API routes (no Theia)"
```

---

## Task 7: Port lsp-server-manager.ts (optional — can skip for first working version)

**Files:**
- Create: `server/src/lsp-server-manager.ts`

The original has no Theia runtime deps — it uses `child_process`, `net`, `http`. Remove the `@injectable()` decorator.

**Step 1: Read `app/src/node/lsp-server-manager.ts`**

**Step 2: Write `server/src/lsp-server-manager.ts`**

Remove `@injectable()` and Theia imports. Export a singleton:
```typescript
export const lspServerManager = new LspServerManager();
```

The `attachWebSocket(server)` method stays the same — it intercepts HTTP upgrade at `/lsp/:lang`.

**Step 3: Build check**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/lsp-server-manager.ts
git commit -m "feat(server): port lsp-server-manager (no Theia)"
```

---

## Task 8: Write server.ts (Express + ws entry point)

**Files:**
- Create: `server/src/server.ts`

**Step 1: Write `server/src/server.ts`**

```typescript
import * as express from 'express';
import * as http from 'http';
import * as path from 'path';
import { loadConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';
import { registerApiRoutes } from './api';
import { attachPtyWebSockets } from './ws-pty';
import { lspServerManager } from './lsp-server-manager';

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const FRONTEND_DIR = path.join(__dirname, '../../client/dist');

async function main(): Promise<void> {
    const cfg = loadConfig(CONFIG_PATH);
    const secret = loadOrCreateSecret(path.join(__dirname, '../../.secret'));

    const app = express();
    const server = http.createServer(app);

    // 1. Auth (must be before static serving)
    const store = registerAuth({ password: cfg.password, secret, app, server });

    // 2. API routes
    registerApiRoutes(app, cfg);

    // 3. Serve frontend
    app.use(express.static(FRONTEND_DIR));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    });

    // 4. WebSocket channels
    attachPtyWebSockets(server);
    lspServerManager.attachWebSocket(server);

    // 5. Auth WS guard (after PTY/LSP attach so ordering is preserved)
    if (store) registerAuthWS({ password: cfg.password, server, store });

    server.listen(cfg.port, '0.0.0.0', () => {
        console.log(`Mineo running at http://0.0.0.0:${cfg.port}`);
        console.log(`Workspace: ${cfg.workspace}`);
    });
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Build**
```bash
cd /Users/nhath/Documents/projects/mineo/server && npx tsc 2>&1 | head -30
```

Fix any errors. Expected: `dist/server.js` created.

**Step 3: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add server/src/server.ts
git commit -m "feat(server): add Express+ws entry point, wire all middleware"
```

---

## Task 9: Bootstrap client/ package + webpack

**Files:**
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/webpack.config.js`

**Step 1: Create `client/package.json`**

```json
{
  "name": "mineo-client",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "webpack",
    "watch": "webpack --watch"
  },
  "dependencies": {
    "golden-layout": "^2.6.0",
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0"
  },
  "devDependencies": {
    "@types/node": "^18.0.0",
    "css-loader": "^6.0.0",
    "mini-css-extract-plugin": "^2.0.0",
    "ts-loader": "^9.0.0",
    "typescript": "^5.4.0",
    "webpack": "^5.0.0",
    "webpack-cli": "^5.0.0"
  }
}
```

**Step 2: Create `client/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create `client/webpack.config.js`**

```javascript
const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'source-map',
    entry: './src/main.ts',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
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
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
    ],
};
```

**Step 4: Create `client/dist/index.html`** (static, committed):

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

**Step 5: Install deps**
```bash
cd /Users/nhath/Documents/projects/mineo/client && npm install
```

**Step 6: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add client/package.json client/tsconfig.json client/webpack.config.js client/dist/index.html client/package-lock.json
git commit -m "chore(client): bootstrap golden-layout+xterm frontend package"
```

---

## Task 10: Write client source files

**Files:**
- Create: `client/src/pty-control-service.ts`
- Create: `client/src/nvim-widget.ts`
- Create: `client/src/layout-manager.ts`
- Create: `client/src/main.ts`
- Create: `client/src/style/main.css`

**Step 1: Write `client/src/pty-control-service.ts`**

```typescript
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
```

**Step 2: Write `client/src/nvim-widget.ts`**

```typescript
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
```

**Step 3: Write `client/src/layout-manager.ts`**

```typescript
import { GoldenLayout, ComponentContainer, LayoutConfig, ResolvedComponentItemConfig } from 'golden-layout';
import { NvimWidget } from './nvim-widget';
import { ptyControlService, PaneRole } from './pty-control-service';

const STORAGE_KEY = 'mineo.layout';
const pool = new Map<string, NvimWidget>();

function uuid(): string { return crypto.randomUUID(); }
function cwd(): string | undefined { const h = location.hash.replace(/^#/, ''); return h.startsWith('/') ? h : undefined; }

function getOrCreate(instanceId: string, role: PaneRole): NvimWidget {
    let w = pool.get(instanceId);
    if (!w) {
        w = new NvimWidget(instanceId, role);
        pool.set(instanceId, w);
        ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: cwd() });
        w.connectChannels();
        w.onExit(() => pool.delete(instanceId));
    }
    return w;
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

export class LayoutManager {
    private gl: GoldenLayout;

    constructor(container: HTMLElement) {
        this.gl = new GoldenLayout(container);

        const mount = (glc: ComponentContainer, state: unknown) => {
            const { instanceId, role } = state as { instanceId: string; role: PaneRole };
            const w = getOrCreate(instanceId, role);
            glc.element.appendChild(w.element);
            w.attach();
            glc.on('resize', () => w.fitAndResize());
            glc.on('shown', () => { w.attach(); w.fitAndResize(); });
            glc.on('destroy', () => { pool.delete(instanceId); ptyControlService.kill(instanceId); w.dispose(); });
        };

        this.gl.registerComponentFactoryFunction('neovim', mount);
        this.gl.registerComponentFactoryFunction('terminal', mount);

        const saved = this.load();
        try {
            this.gl.loadLayout(saved ?? defaultLayout());
        } catch {
            this.gl.loadLayout(defaultLayout());
        }

        this.gl.on('stateChanged', () => this.save());
        window.addEventListener('resize', () => this.gl.updateSize());
    }

    addPane(role: PaneRole = 'neovim'): void {
        this.gl.addComponent(role, { instanceId: uuid(), role }, role === 'terminal' ? 'Terminal' : 'Neovim');
    }

    private save(): void {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.gl.saveLayout())); } catch { /* ignore */ }
    }

    private load(): LayoutConfig | null {
        try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
    }
}
```

**Step 4: Write `client/src/main.ts`**

```typescript
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './style/main.css';
import { LayoutManager } from './layout-manager';

document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('mineo-root')!;
    const manager = new LayoutManager(root);

    // Toolbar: + Neovim, + Terminal
    const toolbar = document.createElement('div');
    toolbar.className = 'mineo-toolbar';

    const mkBtn = (label: string, action: () => void) => {
        const b = document.createElement('button');
        b.className = 'mineo-toolbar-btn';
        b.textContent = label;
        b.addEventListener('click', action);
        toolbar.appendChild(b);
    };

    mkBtn('+ Neovim', () => manager.addPane('neovim'));
    mkBtn('+ Terminal', () => manager.addPane('terminal'));

    document.body.appendChild(toolbar);
});
```

**Step 5: Write `client/src/style/main.css`**

```css
*, *::before, *::after { box-sizing: border-box; }

html, body {
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    background: #0d0d17;
    overflow: hidden;
    font-family: system-ui, sans-serif;
}

#mineo-root {
    width: 100vw;
    height: calc(100vh - 36px);
}

.nvim-widget { width: 100%; height: 100%; }
.xterm { height: 100%; padding: 4px; }
.xterm-viewport { overflow-y: hidden !important; }

/* Toolbar */
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

**Step 6: Build**
```bash
cd /Users/nhath/Documents/projects/mineo/client && npm run build 2>&1 | tail -10
```

Expected: `client/dist/bundle.js` and `client/dist/bundle.css` created.

**Step 7: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add client/src/
git commit -m "feat(client): add full golden-layout+xterm frontend source"
```

---

## Task 11: Update root package.json + start script

**Files:**
- Modify: `/Users/nhath/Documents/projects/mineo/package.json`
- Create: `scripts/start-new.js`

**Step 1: Read current root `package.json`**

**Step 2: Add new scripts**

Add to the `scripts` section:
```json
"start:new": "node scripts/start-new.js",
"build:server": "cd server && npm run build",
"build:client": "cd client && npm run build",
"build:all": "npm run build:server && npm run build:client"
```

**Step 3: Write `scripts/start-new.js`**

```javascript
#!/usr/bin/env node
const { execFileSync } = require('child_process');
const path = require('path');

const serverDist = path.join(__dirname, '../server/dist/server.js');
execFileSync('node', [serverDist], { stdio: 'inherit' });
```

**Step 4: Build and start**
```bash
cd /Users/nhath/Documents/projects/mineo
npm run build:server && npm run build:client
node server/dist/server.js
```

Open `http://localhost:3000` — verify golden-layout loads with a Neovim pane.

**Step 5: Commit**
```bash
cd /Users/nhath/Documents/projects/mineo
git add package.json scripts/start-new.js
git commit -m "chore: add build:all and start:new scripts for new no-Theia stack"
```

---

## Summary

| Task | What | Risk |
|------|------|------|
| 1 | server/ package scaffold | Low |
| 2 | Port config, secret, nvim-ready | None — no Theia deps |
| 3 | Port auth.ts | Low — drop Theia types |
| 4 | Port pty-manager.ts | Low — drop @injectable |
| 5 | ws-pty.ts (WebSocket channels) | Medium — new implementation |
| 6 | api.ts (HTTP routes) | Low |
| 7 | lsp-server-manager.ts | Low — drop @injectable |
| 8 | server.ts entry point | Medium — wires everything |
| 9 | client/ package + webpack | Low |
| 10 | Client source files | Medium — golden-layout API |
| 11 | Root scripts | Low |

**Old `app/` directory can be deleted after the new stack is verified working.**
