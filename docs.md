# Mineo — Minimal Web-Based Neovim IDE
**Design Spec** · 2026-03-12

---

## Overview

Mineo is a minimal, web-based IDE that uses real Neovim as its editing core. It targets Neovim power users who want their full Neovim config and plugins available in a browser — locally or on a remote server. The guiding principle is: as close to "Neovim in a browser" as possible, with just enough shell around it to be usable.

**Stack:** Eclipse Theia (application shell) + vscode-neovim v1.18.12 (VSCode extension loaded via Theia's `@theia/plugin-ext` plugin host)

**Minimum requirements:** Neovim ≥ 0.9.0, Node.js ≥ 18.

---

## Goals

- Real Neovim process — not emulated. All keymaps, plugins, and LSP via `nvim-lspconfig` work.
- Use the user's existing `~/.config/nvim` from the local filesystem — zero migration.
- Minimal Theia shell: file tree, terminal. Nothing else.
- Minimal UI: no menu bar, no activity bar, no breadcrumbs, no tab bar. Editor + file tree + terminal only.
- Simple password auth for remote access. Auth completely disabled when `password` is empty (local use).
- Works locally and on a remote server identically (`npm start`). Served over plain HTTP; users may front with TLS reverse proxy for HTTPS.

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
  ├── Theia Plugin Host (@theia/plugin-ext subprocess — started eagerly at backend init)
  │     └── vscode-neovim extension → nvim --embed (msgpack RPC)
  │           └── user's ~/.config/nvim loaded naturally by Neovim
  ├── File System Provider (@theia/filesystem) → workspace root from config
  ├── Terminal Service (@theia/terminal — xterm.js ↔ node-pty)
  └── GET /healthz → 200 OK (readiness probe)
```

**Key points:**
- vscode-neovim is loaded as a VSCode extension via `@theia/plugin-ext`. The extension spawns `nvim --embed`; Neovim finds `~/.config/nvim` naturally via standard XDG resolution.
- Monaco is the display layer only. vscode-neovim overrides its input and rendering.
- **LSP is handled entirely by `nvim-lspconfig`** inside Neovim. `@theia/languages` is not included. Monaco receives diagnostics, completions, and hover via vscode-neovim's built-in RPC forwarding.
- The plugin host subprocess is started **eagerly at backend init** (not lazily). Neovim is running before any browser connects.
- Auth is `express-session` middleware (with `memorystore` to suppress the default MemoryStore deprecation warning). When `password` is `""`, auth middleware is **not registered at all** — no session middleware, no upgrade interceptor. All requests pass through without any auth check.

---

## Project Structure

```
mineo/
├── app/
│   ├── package.json              # Theia app — lists included packages and plugin dir
│   ├── webpack.config.js         # Frontend bundle → dist/
│   └── src/
│       ├── browser/
│       │   ├── mineo-frontend-module.ts  # DI: rebinds unwanted Theia UI widgets to no-ops
│       │   └── style/
│       │       ├── suppress.css          # CSS: hides residual Theia chrome
│       │       └── theme.css             # One Dark Pro (MIT, full license header preserved)
│       └── node/
│           └── mineo-backend-module.ts   # DI: registers auth + healthz BackendApplicationContribution
│
├── plugins/
│   └── vscode-neovim.vsix        # Downloaded by scripts/download-plugins.sh
│
├── scripts/
│   └── download-plugins.sh       # Downloads vscode-neovim v1.18.12; verifies SHA-256 checksum
│
├── lib/                          # Compiled backend output (gitignored)
├── dist/                         # Frontend webpack bundle (gitignored)
├── .secret                       # Auto-generated session secret (gitignored)
│
├── config.json                   # Local config (gitignored)
├── config.example.json           # Committed example with all fields and defaults
└── package.json                  # Root npm workspace; scripts: build, start, test, download-plugins
```

**Build:** `tsc` compiles `app/src/node/` → `lib/`; `webpack` bundles `app/src/browser/` → `dist/`. Both run via `npm run build`.

**Start:** `npm start` invokes `node lib/backend/main.js` — the standard Theia backend entry point.

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
| `workspace` | string | `"~/projects"` | Single-root workspace directory. Tilde expanded at config-load time using Node's `os.homedir()` replacement (not at spawn time). Must exist or server exits. |
| `password` | string | `""` | Empty = auth fully disabled |
| `nvim.bin` | string | `"nvim"` | Path to Neovim binary. Tilde expanded at **config-load time** (before spawn), using `os.homedir()` replacement. |

**Neovim config:** Not configurable — Neovim resolves `~/.config/nvim` naturally. No env var manipulation.

**Config validation:**
- Unknown keys: silently ignored
- Wrong types: warn to stderr (`[config] port must be a number, using default 3000`) and use the default
- Missing file: all defaults used; warns: `[config] config.json not found, using defaults`
- No JSON schema file in v1

**Workspace auto-open mechanism:** The backend redirects the browser's initial `GET /` to `/?folder=<encoded-workspace-path>`. Theia's `WorkspaceService` picks up the `folder` URL parameter and opens it as the single-root workspace automatically.

---

## Theia Packages

| Package | Purpose |
|---|---|
| `@theia/core` | Base shell, layout, commands, keybindings |
| `@theia/editor` | Editor abstraction |
| `@theia/monaco` | Monaco editor (vscode-neovim's display target) |
| `@theia/filesystem` | File system access |
| `@theia/navigator` | File tree widget |
| `@theia/terminal` | Integrated terminal (xterm.js + node-pty) |
| `@theia/plugin-ext` | VSCode extension host — loads vscode-neovim |
| `@theia/messages` | Minimal notification toasts |

**Not included:** `@theia/languages`, `@theia/git`, `@theia/search-in-workspace`, `@theia/debug`, `@theia/extension-manager`, `@theia/output`, `@theia/scm`, and all others.

**UI suppression:**

1. **DI rebinding** (`mineo-frontend-module.ts`): `MenuBarWidget`, `ActivityBarWidget`, and `BreadcrumbsRenderer` rebound to empty no-op implementations. These are full layout participants; replacing them with no-ops removes them from the shell layout cleanly.

2. **CSS** (`suppress.css`): Loaded as a frontend contribution. Targets `.p-TabBar` with `display: none; height: 0; min-height: 0; overflow: hidden`. Also sets `flex: 1` explicitly on the editor container to ensure it fills space vacated by the tab bar. Theia's layout engine does not query `.p-TabBar` dimensions if the widget is hidden and flex-collapsed; this approach is safe for resize events. Additional residual chrome (borders, panel handles) suppressed with specific selectors as found during integration.

---

## Neovim Integration

**Startup sequence:**
1. `node lib/backend/main.js` starts
2. Config loaded; tilde paths expanded
3. Workspace directory existence checked (fatal if missing)
4. Session secret loaded from `.secret` (or generated and saved if missing)
5. Auth middleware registered (entirely skipped if `password` is `""`)
6. `GET /healthz` route registered
7. `@theia/plugin-ext` plugin host subprocess started **eagerly**
8. Plugin host loads `plugins/vscode-neovim.vsix`
9. vscode-neovim spawns `nvim --embed` using expanded `nvim.bin`
10. Backend logs `Mineo ready on http://localhost:<port>` to stdout
11. Browser connects → WebSocket established → workspace root auto-opened via `?folder=` redirect

**Input/rendering loop:**
- Keystroke → vscode-neovim frontend → JSON-RPC WS → plugin host → msgpack RPC → Neovim → screen state → Monaco API calls → browser renders

**vscode-neovim version:** `v1.18.12`, pinned in `scripts/download-plugins.sh`. SHA-256 checksum of the `.vsix` hardcoded in the script and verified before use.

**Neovim crash recovery:** vscode-neovim's built-in restart logic fires (3 attempts — this is vscode-neovim's default behaviour, not configured by Mineo). If all fail: toast "Neovim failed to start. Check your nvim config." Editor becomes inert; user reloads the page.

**VSCode API shims:** None pre-written. If gaps are found, they are added to `app/src/node/neovim-shims.ts` with inline comments: missing API name, Theia version where gap exists, and shim approach.

---

## UI & Minimalism

**Default layout:**
```
┌─────────────────────────────────────────────┐
│ [▸] │ [editor — Monaco / vscode-neovim]     │
│     │                                       │
│     │                                       │
│     ├───────────────────────────────────────│
│     │ [terminal — hidden by default]        │
└─────────────────────────────────────────────┘
```

- **File tree:** Hidden by default. Toggled via `Ctrl+B` (Theia's `explorer.toggle` command).
- **Terminal:** Hidden by default. Toggled via `` Ctrl+` ``.
- **Tab bar:** Hidden via CSS as described in Theia Packages section. Buffer switching via Neovim.
- **Mode indicator:** vscode-neovim natively contributes a status bar item showing NORMAL / INSERT / VISUAL / etc. Theia's status bar is kept.
- **Theme:** One Dark Pro, CSS extracted from the [One Dark Pro VSCode extension](https://github.com/Binaryify/OneDark-Pro) (MIT license). Full license header (copyright notice + license text) preserved verbatim in `theme.css` as required by the MIT license.
- **No menu bar, activity bar, breadcrumbs:** Removed via DI rebinding.

---

## Authentication

**Session secret:** On first startup, `crypto.randomBytes(32).toString('hex')` is written to `.secret` (gitignored). On subsequent startups, the secret is read from `.secret`. The secret is completely independent of the password.

**Library:** `express-session` with `memorystore` session store (prevents the default MemoryStore deprecation warning). Single-process only in v1.

**Cookie:** `httpOnly: true`, `sameSite: 'strict'`, `maxAge: 7 days`.

**CSRF:** The login POST form uses `sameSite: 'strict'` cookies. No additional CSRF token is implemented in v1. This is an accepted limitation — Mineo is a single-user self-hosted tool. Documented as a known gap.

**Login flow:**
1. Any HTTP request without a valid session → redirect to `/login`
2. `/login` serves plain HTML with a password field
3. Correct password → session created → redirect to `/?folder=<workspace>`
4. Wrong password → re-render login with "Incorrect password". No lockout.

**WebSocket auth:**
- Intercepted at the Node.js HTTP server `upgrade` event, before Theia's WS library processes it
- The `Cookie` header from the upgrade request is parsed using `express-session`'s `store.get(sessionId, cb)` to validate the session ID against the in-memory store (not just checking cookie existence)
- Invalid or missing session → respond with `HTTP 401`; socket destroyed; no WS upgrade
- Applied to all WebSocket upgrade paths uniformly
- When `password` is `""`, this interceptor is not registered

**Health check:** `GET /healthz` returns `200 OK` with body `{"status":"ok"}`. No auth required. Available immediately once the HTTP server starts (before plugin host is ready).

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `nvim` binary not found at startup | Process exits: `Error: nvim not found at "<bin>". Install Neovim or fix nvim.bin in config.json.` |
| `config.json` missing | Defaults used; logs: `[config] config.json not found, using defaults.` |
| `workspace` directory not found | Process exits: `Error: Workspace not found: "<path>". Create it or update workspace in config.json.` |
| Port already in use | Node.js `EADDRINUSE` to stderr; process exits. |
| Wrong password | Login re-renders: "Incorrect password." No crash. |
| Neovim crash | vscode-neovim auto-restarts (3 attempts, built-in). On failure: toast "Neovim failed to start. Check your nvim config." Editor inert; reload to recover. |
| `.vsix` file missing | Plugin host fails to load extension; editor inert. Toast: "vscode-neovim plugin not found. Run: npm run download-plugins" |
| Plugin host fails to start | Error logged to stderr. Editor inert. HTTP server, file tree, terminal, and auth still functional. |
| `.secret` file unwritable | Process exits: `Error: Cannot write session secret to .secret. Check file permissions.` |

---

## Testing

**Smoke test (`npm test`):** Playwright script that:
1. Starts the Mineo server (test config: password `"test"`, temp workspace dir)
2. Waits for `GET /healthz` to return 200 (readiness gate — polls with 100ms interval, 10s timeout)
3. Opens headless Chromium, navigates to `http://localhost:<port>`
4. Asserts login page present (password input in DOM)
5. Submits password `"test"`
6. Asserts Monaco editor element present in DOM
7. Sends keypress `i`
8. `waitForFunction(() => statusBarText === 'INSERT')` with 5s timeout
9. Sends `Escape`
10. `waitForFunction(() => statusBarText === 'NORMAL')` with 5s timeout
11. Sends `Ctrl+B`
12. Asserts navigator widget visible in DOM
13. Kills server; temp workspace cleaned up

**Manual checklist (pre-release):**
- [ ] Login page appears; wrong password shows "Incorrect password"
- [ ] Correct password opens IDE
- [ ] File tree toggles with `Ctrl+B`
- [ ] Terminal opens with `` Ctrl+` `` and accepts shell input
- [ ] Neovim mode indicator shows NORMAL/INSERT in status bar
- [ ] Opening a file from the file tree loads it in the editor
- [ ] User's `init.lua`/`init.vim` is loaded (verify via a custom highlight or keymap)
- [ ] LSP diagnostics appear in a project with `nvim-lspconfig` configured

---

## Running

```bash
# 1. Install dependencies
npm install

# 2. Download vscode-neovim plugin (v1.18.12, checksum verified)
npm run download-plugins

# 3. Build (tsc + webpack)
npm run build

# 4. Create config
cp config.example.json config.json
# Edit config.json: set workspace and optionally a password

# 5. Start
npm start
# → Open http://localhost:3000
# → .secret is auto-generated on first run
```

**Remote server:** SSH in, run the same steps. Front with nginx or Caddy for HTTPS + domain. No other changes needed.
