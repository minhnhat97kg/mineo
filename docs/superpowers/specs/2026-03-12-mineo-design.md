# Mineo — Design Spec
**Date:** 2026-03-12
**Status:** Approved

---

## Overview

Mineo is a minimal, web-based IDE that uses real Neovim as its editing core. It targets Neovim power users who want their full Neovim config and plugins available in a browser — locally or on a remote server. Guiding principle: as close to "Neovim in a browser" as possible, with just enough shell around it to be usable.

**Stack:** Eclipse Theia 1.69 (latest stable) browser-app (scaffolded via `@theia/cli`) + vscode-neovim v1.18.12 (VSCode extension loaded via Theia's `@theia/plugin-ext` plugin host).

**Minimum requirements:** Neovim ≥ 0.9.0, Node.js ≥ 18.

---

## Goals

- Real Neovim process — not emulated. All keymaps, plugins, and LSP via `nvim-lspconfig` work.
- Use the user's existing `~/.config/nvim` — zero migration.
- Minimal Theia shell: file tree, terminal. Nothing else.
- Minimal UI: no menu bar, no activity bar, no breadcrumbs, no tab bar. Editor + file tree + terminal only.
- Simple password auth for remote access. Auth completely disabled when `password` is empty.
- Works locally and on a remote server identically (`npm start`). Served over HTTP; users may front with TLS proxy for HTTPS.

---

## Architecture

```
Browser
  └── Theia Frontend (React + Monaco)
        └── vscode-neovim frontend (keybindings, cursor sync, visual mode)
              │ WebSocket (Theia JSON-RPC — /services path)
              ▼
Theia Backend (Node.js / Express)
  ├── Auth Middleware (express-session + memorystore; omitted when password is "")
  ├── Theia Plugin Host (@theia/plugin-ext subprocess — started eagerly)
  │     └── vscode-neovim extension → nvim --embed (msgpack RPC)
  │           └── user's ~/.config/nvim loaded via XDG
  ├── File System Provider (@theia/filesystem) → workspace root from config
  ├── Terminal Service (@theia/terminal — xterm.js ↔ node-pty)
  └── GET /healthz → 200 OK
```

**Key points:**
- vscode-neovim is loaded as a VSCode extension via `@theia/plugin-ext`. The extension spawns `nvim --embed`; Neovim finds `~/.config/nvim` naturally via XDG resolution.
- Monaco is the display layer only. vscode-neovim overrides its input and rendering.
- LSP is handled entirely by `nvim-lspconfig` inside Neovim. `@theia/languages` is not included.
- The plugin host subprocess is started **eagerly at backend init** — Neovim is running before any browser connects.
- When `password` is `""`, auth middleware is not registered at all.

---

## Project Structure

```
mineo/
├── app/
│   ├── package.json              # Theia browser-app manifest (no webpack.config.js — @theia/cli owns the webpack config)
│   └── src/
│       ├── browser/
│       │   ├── mineo-frontend-module.ts
│       │   └── style/
│       │       ├── suppress.css
│       │       └── theme.css
│       └── node/
│           └── mineo-backend-module.ts
│
├── plugins/
│   └── vscode-neovim.vsix        # Downloaded by scripts/download-plugins.sh
│
├── scripts/
│   └── download-plugins.sh
│
├── tests/
│   └── smoke.spec.ts             # Playwright smoke test
│
├── lib/                          # Compiled backend output (gitignored)
├── dist/                         # Frontend webpack bundle (gitignored)
├── .secret                       # Auto-generated session secret (gitignored)
│
├── config.json                   # Local config (gitignored)
├── config.example.json
├── package.json                  # Root npm workspace
├── tsconfig.json
├── playwright.config.ts
└── .gitignore
```

**Build:** `npm run build` → `@theia/cli build` (compiles TypeScript + bundles frontend via `@theia/cli`'s internal webpack config; no user-supplied `webpack.config.js` is needed or used).

**Start:** `npm start` → wrapper script reads `config.json`, then invokes `theia start <workspace> --port <port> --plugins local-dir:../plugins` (positional workspace argument, not `--root-dir` which is deprecated).

---

## Configuration

Single `config.json` at the project root (gitignored). `config.example.json` is committed.

```json
{
  "port": 3000,
  "workspace": "~/projects",
  "password": "",
  "nvim": {
    "bin": "nvim"
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `port` | number | `3000` | Port to listen on |
| `workspace` | string | `"~/projects"` | Tilde expanded at config-load time. Must exist or server exits. |
| `password` | string | `""` | Empty = auth fully disabled |
| `nvim.bin` | string | `"nvim"` | Tilde expanded at config-load time. |

**Validation:**
- Unknown keys: silently ignored
- Wrong types: warn to stderr (e.g., `[config] port must be a number, using default 3000`) and use default
- Missing file: warn `[config] config.json not found, using defaults` and use all defaults
- No JSON schema in v1

**Workspace auto-open:** The `npm start` wrapper script passes `<workspace>` as the positional argument to `theia start` (e.g. `theia start /home/user/projects --port 3000 --plugins ...`). Theia opens this path as the single-root workspace automatically.

---

## Theia Packages

| Package | Purpose |
|---|---|
| `@theia/core` | Base shell, layout, commands, keybindings |
| `@theia/editor` | Editor abstraction |
| `@theia/monaco` | Monaco editor |
| `@theia/filesystem` | File system access |
| `@theia/navigator` | File tree widget |
| `@theia/terminal` | Terminal (xterm.js + node-pty) |
| `@theia/plugin-ext` | VSCode extension host — loads vscode-neovim |
| `@theia/messages` | Notification toasts |

**Not included:** `@theia/languages`, `@theia/git`, `@theia/search-in-workspace`, `@theia/debug`, `@theia/extension-manager`, `@theia/output`, `@theia/scm`, and all others.

---

## UI Suppression

### DI Rebinding (`mineo-frontend-module.ts`)

A `ContainerModule` rebinds Theia UI contributions to suppress unwanted chrome. The correct DI symbols for Theia 1.69:

- **Menu bar:** Rebind `MenuContribution` — provide a no-op `MenuContribution` that registers nothing. This prevents the top-level menu from being populated. Alternatively, `ApplicationShellOptions` can suppress the menu panel.
- **Activity bar / side panel:** Rebind `ApplicationShellOptions` with `leftPanelSize: 0` and hide the left-panel toggle; or rebind `SidePanelHandlerFactory` to a no-op. The Theia shell has no standalone `ActivityBarWidget` DI symbol — it is part of the shell layout and suppressed via shell options.
- **Breadcrumbs:** Rebind `BreadcrumbsContribution` to a no-op implementation (the binding exported from `@theia/navigator/lib/browser/breadcrumbs`).

Note: There is no `MenuBarWidget` or `ActivityBarWidget` DI symbol in `@theia/core`'s public API. The correct tokens are `MenuContribution`, `ApplicationShellOptions`, and `BreadcrumbsContribution` as described above.

### CSS (`suppress.css`)

Targets `.lm-TabBar` (Lumino — Theia 1.27+):
```css
.lm-TabBar {
  display: none;
  height: 0;
  min-height: 0;
  overflow: hidden;
}
```

Also sets `flex: 1` on the editor container to fill vacated space. Additional residual chrome selectors added as found during integration.

### Theme (`theme.css`)

One Dark Pro colors, CSS extracted from the [One Dark Pro VSCode extension](https://github.com/Binaryify/OneDark-Pro) (MIT license). Full license header (copyright notice + full license text) preserved verbatim in `theme.css` as required by the MIT license.

---

## Backend Module & Auth

`mineo-backend-module.ts` registers a `BackendApplicationContribution`. Theia calls `configure(app)` during startup.

### Startup Sequence

1. Config loaded; types validated; tildes expanded
2. Workspace directory existence checked (fatal if missing)
3. `nvim` binary existence checked (fatal if not found)
4. Session secret loaded from `.secret` (generated if missing)
5. Auth middleware registered (entirely skipped if `password` is `""`)
6. `GET /healthz` route registered
7. Plugin host subprocess started eagerly
8. Plugin host loads `plugins/vscode-neovim.vsix`
9. vscode-neovim spawns `nvim --embed`
10. Backend logs `Mineo ready on http://localhost:<port>`
11. Browser connects → WebSocket established → workspace auto-opened (passed as positional argument to `theia start`)

### Session Secret

`crypto.randomBytes(32).toString('hex')` written to `.secret` on first startup. Read from `.secret` on subsequent startups. Independent of password. If `.secret` is unwritable: process exits with error message.

### Auth Middleware (when `password !== ""`)

- `express-session` with `memorystore` store
- **`memorystore` instantiation:** `memorystore` is a factory — instantiate as:
  ```js
  const MemoryStore = require('memorystore')(session);
  const store = new MemoryStore({ checkPeriod: 86400000 }); // prune expired sessions every 24h
  ```
  Do NOT use `new require('memorystore')(...)` directly — the factory must be called with `session` first.
- Cookie: `httpOnly: true`, `sameSite: 'strict'`, `maxAge: 7 days`
- All non-`/healthz` non-`/login` routes protected
- `GET /login` → plain HTML form with password field
- `POST /login` → correct password creates session, redirects to `/`; wrong password re-renders form with "Incorrect password"
- No lockout in v1

### WebSocket Auth (when `password !== ""`)

Intercepted at `server.on('upgrade', ...)` before Theia's WS library:
- Parse `Cookie` header
- Call `store.get(sessionId, cb)` to validate against in-memory store
- Invalid/missing session → `HTTP 401` response + socket destroy
- Applied to all WebSocket upgrade paths uniformly

### Health Check

`GET /healthz → 200 {"status":"ok"}`. No auth required. Available once HTTP server starts (before plugin host is ready).

---

## Plugin Download Script

`scripts/download-plugins.sh`:
- Downloads `vscode-neovim v1.18.12` `.vsix` from the GitHub releases URL
- Verifies SHA-256 checksum (hardcoded in script, computed from official release)
- Saves to `plugins/vscode-neovim.vsix`
- Exits with non-zero status and clear error message if checksum mismatches

**Plugin directory configuration:** `theia start` is invoked with `--plugins local-dir:../plugins` (passed by the `npm start` wrapper script). There is no `theiaPluginsDir` field in `app/package.json` — plugins are passed as a CLI flag.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `nvim` binary not found | Process exits: `Error: nvim not found at "<bin>". Install Neovim or fix nvim.bin in config.json.` |
| `config.json` missing | Defaults used; warns: `[config] config.json not found, using defaults.` |
| `workspace` not found | Process exits: `Error: Workspace not found: "<path>". Create it or update workspace in config.json.` |
| Port in use | Node.js `EADDRINUSE` to stderr; process exits. |
| Wrong password | Login re-renders: "Incorrect password." No crash. |
| Neovim crash | vscode-neovim's built-in disconnect handler attempts to reconnect to `nvim --embed`. If reconnection fails, the extension surfaces an error notification. Mineo does not implement its own retry logic — exact retry behavior depends on vscode-neovim internals. On unrecoverable failure: toast "Neovim failed to start. Check your nvim config." Editor inert; user reloads. |
| `.vsix` missing | Checked at startup; if absent, warns to stderr. Toast: "vscode-neovim plugin not found. Run: npm run download-plugins" |
| Plugin host fails | Error to stderr. Editor inert. HTTP server, file tree, terminal, auth still functional. |
| `.secret` unwritable | Process exits: `Error: Cannot write session secret to .secret. Check file permissions.` |

---

## Testing

### Smoke Test (`npm test`)

`tests/smoke.spec.ts` — Playwright, Chromium only, no retries:

1. Spawn Mineo server (test config: `password: "test"`, temp workspace dir, random port)
2. Poll `GET /healthz` every 100ms, 10s timeout — readiness gate
3. Open headless Chromium, navigate to `http://localhost:<port>`
4. Assert login page: password `<input>` in DOM
5. Submit password `"test"`
6. Assert Monaco editor element (`.monaco-editor`) in DOM
7. Send keypress `i`
8. `page.waitForFunction(() => document.querySelector('#vscode-neovim-status')?.textContent?.includes('INSERT'))` — 5s timeout. (vscode-neovim contributes a VSCode API `StatusBarItem` with id `"vscode-neovim-status"`; Theia renders it as a DOM element with `id="vscode-neovim-status"`. The exact selector should be verified during integration and updated if needed.)
9. Send `Escape`
10. `page.waitForFunction(() => !document.querySelector('#vscode-neovim-status')?.textContent?.includes('INSERT') && !document.querySelector('#vscode-neovim-status')?.textContent?.includes('VISUAL'))` — 5s timeout (NORMAL mode: INSERT and VISUAL indicators absent)
11. Send `Ctrl+B`
12. Assert navigator widget visible in DOM
13. Kill server; remove temp workspace

### Manual Checklist (pre-release)

- [ ] Login page appears; wrong password shows "Incorrect password"
- [ ] Correct password opens IDE
- [ ] File tree toggles with `Ctrl+B`
- [ ] Terminal opens with `Ctrl+\`` and accepts shell input
- [ ] Neovim mode indicator shows NORMAL/INSERT in status bar
- [ ] Opening a file from file tree loads it in the editor
- [ ] User's `init.lua`/`init.vim` is loaded (verify via custom highlight or keymap)
- [ ] LSP diagnostics appear in a project with `nvim-lspconfig` configured

---

## Running

```bash
# 1. Install dependencies
npm install

# 2. Download vscode-neovim plugin (v1.18.12, checksum verified)
npm run download-plugins

# 3. Build (TypeScript + frontend bundle via @theia/cli)
npm run build

# 4. Create config
cp config.example.json config.json
# Edit config.json: set workspace and optionally a password

# 5. Start
npm start
# → Open http://localhost:3000
# → .secret auto-generated on first run
```

**Remote server:** SSH in, run the same steps. Front with nginx or Caddy for HTTPS + domain. No other changes needed.

---

## Known Gaps / v1 Limitations

- **CSRF:** Login POST uses `sameSite: 'strict'` cookies only. No CSRF token. Accepted for v1 — single-user self-hosted tool.
- **Single process:** Auth sessions are in-memory. Restarting the server logs out all sessions.
- **No lockout:** Wrong password attempts are unlimited.
- **VSCode API shims:** Added to `app/src/node/neovim-shims.ts` if gaps are found during integration (not pre-written).
