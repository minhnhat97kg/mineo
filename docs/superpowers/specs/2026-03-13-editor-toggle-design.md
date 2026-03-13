# Mineo — Editor Toggle Design
**Date:** 2026-03-13
**Status:** Approved

---

## Overview

Mineo supports two mutually exclusive editor modes:

| Mode | Main area | File-open behavior |
|---|---|---|
| `neovim` (default) | Neovim terminal widget | `/api/nvim-open` RPC → nvim process |
| `monaco` | Monaco/vscode-neovim editor | Default Theia open handler |

The user switches modes via a status bar button. Mode is persisted across reloads via `localStorage`. On startup, Mineo activates the saved mode (default: `neovim`). In `neovim` mode, the nvim process is auto-started with an RPC listen socket so file-open from the explorer works without any manual setup.

---

## State

**`ModeService`** — frontend injectable singleton in `mineo-frontend-module.ts`.

- `currentMode: 'neovim' | 'monaco'`
- `onModeChange: Event<'neovim' | 'monaco'>` — fired after every successful toggle
- `toggle()` — calls the appropriate backend API, updates `currentMode`, persists to `localStorage('mineo.editorMode')`, fires `onModeChange`
- On construction: reads `localStorage('mineo.editorMode')` → default `'neovim'`

---

## Backend API

Three routes in `MineoBACContribution.configure()`:

### `POST /api/nvim-start`
1. If nvim process handle is alive AND `/tmp/nvim.sock` exists → return `{ok: true}` immediately
2. Spawn `nvim --listen /tmp/nvim.sock` via `node-pty` (pty required for terminal rendering)
3. Store `IPty` handle at module scope as `nvimProcess`
4. Poll for `/tmp/nvim.sock` existence: 100ms interval, 3s timeout
5. On socket found → `{ok: true}`
6. On timeout → `503 {error: 'Neovim failed to start'}`, kill the spawned process

### `POST /api/nvim-stop`
1. If `nvimProcess` exists → send SIGTERM, clear handle
2. Remove `/tmp/nvim.sock` if it exists
3. Return `{ok: true}`

### `GET /api/nvim-open?file=<abs-path>` *(existing, unchanged)*
- Validates path (absolute, no `..`, within workspace)
- Calls `nvim --server /tmp/nvim.sock --remote-silent <file>`
- `503` if socket missing (nvim not running)

**Socket path:** `/tmp/nvim.sock` — hardcoded, single-user tool.

**Process handle:** stored at module scope alongside `cfg` and `secret` (same pattern).

---

## Frontend Changes

### `ModeService` (new)
Injectable singleton. Holds `currentMode`, exposes `toggle()` and `onModeChange` event. Persists to `localStorage`. Default: `'neovim'`.

### `NvimTerminalContribution` (updated)
- Subscribes to `ModeService.onModeChange`
- **Neovim mode activation:**
  1. Call `POST /api/nvim-start`
  2. On success: create terminal widget (if not already open) with `shellPath: 'nvim'` and `env: {NVIM_LISTEN_ADDRESS: '/tmp/nvim.sock'}` — or reattach existing one
  3. Move terminal widget to `main` area, activate it
  4. Collapse/hide Monaco editor widgets
- **Monaco mode activation:**
  1. Call `POST /api/nvim-stop`
  2. Move terminal widget out of `main` area (to bottom panel, collapsed)
  3. Restore Monaco editor to `main` area

### `NvimOpenHandler` (updated)
- Injects `ModeService`
- `canHandle(uri)`: returns `20000` when `currentMode === 'neovim'`; returns `0` otherwise (lets default Theia handler win with Monaco)

### Status Bar Button (new `EditorModeStatusBarContribution`)
- Implements `FrontendApplicationContribution`
- On init: registers a status bar entry showing `$(terminal) Neovim` or `$(edit) Monaco`
- Click → `ModeService.toggle()`
- Subscribes to `ModeService.onModeChange` to update label

### Startup (`onDidInitializeLayout`)
In `NvimTerminalContribution`:
1. Read mode from `ModeService` (which already read `localStorage`)
2. If `neovim`: call `POST /api/nvim-start`, then activate terminal widget in main area

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `/api/nvim-start` times out | Toast: "Neovim failed to start. Check nvim.bin in config." Mode stays `neovim`. |
| `/api/nvim-open` returns 503 | Toast: "Neovim not running — restarting…". Retry `POST /api/nvim-start` once, then retry open. |
| nvim crashes mid-session | Next file-open gets 503 → auto-restart flow above. |
| Toggle to Monaco while nvim has a file open | nvim keeps the file; Monaco area is empty until user opens something. |

---

## Files Changed

| File | Change |
|---|---|
| `app/src/browser/mineo-frontend-module.ts` | Add `ModeService`, `EditorModeStatusBarContribution`; update `NvimTerminalContribution`, `NvimOpenHandler` |
| `app/src/node/mineo-backend-module.ts` | Add `POST /api/nvim-start`, `POST /api/nvim-stop`; add `node-pty` spawn for nvim process |

No new files. No config schema changes.

---

## Known Constraints

- Socket path `/tmp/nvim.sock` is not configurable in v1. Single-user, single-machine assumption.
- Only one nvim process is managed at a time. Multiple tabs share the same nvim instance.
- `node-pty` is already a transitive dependency via `@theia/terminal`; no new npm dependency.
