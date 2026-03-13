# Mineo — Editor Toggle Design
**Date:** 2026-03-13
**Status:** Approved

---

## Overview

Mineo supports two mutually exclusive editor modes:

| Mode | Main area | File-open behavior |
|---|---|---|
| `neovim` (default) | Neovim in a Theia terminal widget (xterm.js pty) | `/api/nvim-open` RPC → nvim socket |
| `monaco` | Monaco/vscode-neovim editor | Default Theia open handler |

Status bar button toggles modes. Mode persisted via `localStorage('mineo.editorMode')`. Default: `'neovim'`.

**Single nvim process:** The terminal widget spawns nvim via `shellPath: '/bin/sh'`, `shellArgs: ['-c', 'exec nvim --listen /tmp/nvim.sock']`. This gives both a visible TUI editing surface (xterm.js renders nvim's UI) and an RPC socket for programmatic file opens.

---

## State: `ModeService` (new injectable singleton)

```
currentMode: 'neovim' | 'monaco'
onModeChange: Event<'neovim' | 'monaco'>
activate(mode, options?: { startup?: boolean }): Promise<void>
toggle(): Promise<void>
```

**Construction:** reads `localStorage('mineo.editorMode')`. Any value other than `'neovim'` or `'monaco'` → default `'neovim'`.

**`activate(mode, { startup })`:** Runs the mode activation sequence. On success (sequence completes without throwing): updates `currentMode`, writes localStorage, fires `onModeChange`. On failure (sequence throws an exception): runs rollback, toasts the error, does NOT update `currentMode` or fire `onModeChange`. The `startup: true` flag suppresses the dirty-check in step 0 of Neovim activation (no user-created editor state at layout init time) and skips step 2 (no Monaco editors to close at startup).

**`toggle()`:** `activate(currentMode === 'neovim' ? 'monaco' : 'neovim')`.

**Startup:** `NvimTerminalContribution.onDidInitializeLayout()` — single call site — calls `modeService.activate(modeService.currentMode, { startup: true })`. On startup failure, status bar reads `currentMode` directly so it always shows the correct value regardless of whether `onModeChange` fired.

---

## Backend API

### `GET /api/nvim-ready`

```
1. net.createConnection('/tmp/nvim.sock') with 500ms connection timeout
2. On connect: destroy socket, return 200 { ready: true }
3. On any error (ENOENT, ECONNREFUSED, timeout): return 200 { ready: false }
```

Always returns HTTP 200. Frontend poll treats all fetch errors (network, server crash) as `{ready: false}` — non-fatal, same as "not ready yet."

### `GET /api/nvim-open?file=<abs-path>` *(existing, unchanged)*

- Validates: absolute path, no `..`, prefixed by `cfg.workspace`
- Calls `cfg.nvim.bin --server /tmp/nvim.sock --remote-silent <file>`
- `200 {ok: true}` on success; `503 {error: 'Neovim is not running or has crashed. Reload the page.'}` on socket error

Socket path `/tmp/nvim.sock` — hardcoded, not configurable in v1. No `/api/nvim-start` or `/api/nvim-stop`.

---

## Frontend: `NvimTerminalContribution` (updated)

```ts
private nvimWidget: TerminalWidget | undefined;
private _nvimHidden = false;
```

### Neovim mode activation

**Step 0 — dirty-check (skipped when `startup: true`):** Query `EditorManager` for dirty editors. If any exist: throw `'Save or discard Monaco changes before switching to Neovim.'` No widget state has been changed; no rollback needed.

**Step 1 — widget:** If `this.nvimWidget` is set and not disposed: `ApplicationShell.addWidget(this.nvimWidget, { area: 'main' })`, `activateWidget(this.nvimWidget.id)`. Otherwise: create via `TerminalService.newTerminal({ title: 'Neovim', shellPath: '/bin/sh', shellArgs: ['-c', 'exec nvim --listen /tmp/nvim.sock'], env: {} })`, store as `this.nvimWidget`, add to `main`, activate. Track `const created = !preexisting` locally.

**Step 2 — clear Monaco (skipped when `startup: true`):** Iterate `ApplicationShell.mainPanel.widgets`. Close each widget whose `id !== this.nvimWidget.id` via `ApplicationShell.closeWidget(id)`. These widgets are stateless Monaco editors with no unsaved content (guaranteed by step 0). At startup, no Monaco editors exist yet so this step is a no-op; it is skipped to be safe.

**Step 3 — wait for socket:** Poll `GET /api/nvim-ready` every 200ms × 25 (5s total). All fetch errors and `{ready:false}` responses are treated as "not ready yet" — no exception is thrown. The poll loop always returns normally (never throws).
- `{ready: true}` before timeout → complete step 3 silently.
- Timeout → toast "Neovim socket not ready — file opens may not work until nvim initialises." Complete step 3.

Step 3 always completes normally. The activation sequence returns success after step 3 regardless of whether nvim was ready. Degraded state (socket not yet ready): file opens from the explorer will get a 503 and show a toast until nvim finishes initialising, typically within a few seconds.

**Rollback** (exception thrown in step 1 only — step 3 never throws):
- If `created`: `ApplicationShell.closeWidget(this.nvimWidget!.id)`, set `this.nvimWidget = undefined`.
- Closed EditorWidgets from step 2 are not restored (they were stateless; step 0 guarantees no unsaved content).

### Monaco mode activation

**Step 1 — hide nvim widget:** If `this.nvimWidget` is set and not disposed: `ApplicationShell.hideWidget(this.nvimWidget.id)`, set `this._nvimHidden = true`. If `nvimWidget` is undefined: set `this._nvimHidden = false` (Monaco is already the layout default, no action needed).

**Step 2:** Monaco area is already empty — `NvimOpenHandler` returns `-1` in Monaco mode and no files can be opened into Monaco while Neovim is active. This step requires no action. It is listed to make the invariant explicit.

**Rollback** (step 1 throws): if `this._nvimHidden`: `ApplicationShell.showWidget(this.nvimWidget!.id)`, set `this._nvimHidden = false`.

### `onDidInitializeLayout()`

Called by Theia after the shell layout and all services are fully initialised. Single activation call:

```ts
await this.modeService.activate(this.modeService.currentMode, { startup: true });
// startup:true → skips dirty-check (step 0) and close-Monaco (step 2)
```

---

## Frontend: `NvimOpenHandler` (replaces existing)

```ts
canHandle(uri: URI): number {
  if (uri.scheme !== 'file') return -1;
  return this.modeService.currentMode === 'neovim' ? 500 : -1;
}

async open(uri: URI): Promise<object | undefined> {
  const filePath = uri.path.toString();
  try {
    const res = await fetch('/api/nvim-open?file=' + encodeURIComponent(filePath));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      this.messageService.warn('Neovim: ' + ((body as any).error ?? 'HTTP ' + res.status));
      return undefined; // let Theia fall back to other handlers on failure
    }
  } catch (e) {
    this.messageService.error('Could not reach /api/nvim-open: ' + e);
    return undefined;
  }
  return { handled: true };
}
```

- Priority `500` outbids Theia's default file open handler (~100). No other handler in Mineo registers at ≥ 500.
- Returns `undefined` on failure so Theia can fall back to other open handlers.
- Returns `{ handled: true }` only on HTTP 2xx success.

---

## Frontend: `EditorModeStatusBarContribution` (new)

Implements `FrontendApplicationContribution`.

- `onStart()`: register command `'mineo.toggleEditorMode'` → `modeService.toggle()`; call `updateStatusBar()`
- `updateStatusBar()`: `StatusBar.setElement('mineo.editorMode', { text: label(), command: 'mineo.toggleEditorMode', alignment: StatusBarAlignment.LEFT, priority: 10 })`
- `label()`: `'$(terminal-tmux) NeoVim'` when `neovim`, `'$(edit) Monaco'` when `monaco` — reads `modeService.currentMode` directly (correct even if startup activation failed without firing `onModeChange`)
- Subscribe to `modeService.onModeChange` → `updateStatusBar()`

---

## Unsaved State Policy

- **Neovim → Monaco:** `NvimOpenHandler.canHandle()` returns `-1` in Monaco mode, so no files open into Monaco while Neovim is active. Monaco area is always empty when switching back. No dirty-check needed.
- **Monaco → Neovim:** Dirty-check runs at **step 0** of Neovim activation, before any widget state changes. If dirty editors exist: throw (rollback with no widget changes), toast: "Save or discard Monaco changes before switching to Neovim."

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Dirty editors on Monaco→Neovim | Throw at step 0 (no widget changes), toast, mode unchanged |
| Socket not ready after 5s | Toast (non-fatal). Activation succeeds. TUI visible. |
| `/api/nvim-open` returns 503 | Toast: "Neovim is not running or has crashed. Reload the page." |
| `NvimOpenHandler.open()` fails | Toast, return `undefined` (Theia falls back to other handlers) |
| `activate()` exception (any) | Rollback widget state, toast, `currentMode` unchanged, no `onModeChange` |

---

## Files Changed

| File | Change |
|---|---|
| `app/src/browser/mineo-frontend-module.ts` | Add `ModeService`, `EditorModeStatusBarContribution`; replace `NvimOpenHandler`; update `NvimTerminalContribution` |
| `app/src/node/mineo-backend-module.ts` | Add `GET /api/nvim-ready` |

---

## Known Constraints

- `/tmp/nvim.sock` hardcoded. Not configurable in v1.
- nvim binary hardcoded as `'nvim'` inside the shell command (`exec nvim --listen ...`). Does not read `nvim.bin` from config. (Follow-on: expose `GET /api/nvim-bin`.)
- One nvim process at a time. Multiple browser tabs share the same instance.
- No Monaco file tracking across mode switches. Monaco area starts empty after switching back. (Follow-on.)
- `ApplicationShell.hideWidget` / `showWidget` are available in Theia 1.27+. No capability check needed for Theia 1.69.
