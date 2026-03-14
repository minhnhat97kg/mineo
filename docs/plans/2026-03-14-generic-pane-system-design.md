# Generic Pane System Design

**Date:** 2026-03-14
**Status:** Approved

## Overview

Refactor the tiling system to support multiple, parallel pane types (Neovim editor, Monaco editor, terminal) via a self-contained `panes/` registry. Remove the global Monaco/Neovim mode toggle entirely. Each pane independently declares its type when created. A pane header bar with split and close buttons replaces the current drag-handle-only UX.

---

## 1. Data Model Changes (`app/src/common/layout-types.ts`)

- `PaneRole` expands to: `'neovim' | 'terminal' | 'monaco'`
- `LeafNode.widgetId` is removed (was only used for the deprecated `'widget'` role stub)
- `instanceId` remains on all leaves: PTY-backed for `neovim`/`terminal`, a stable UUID key for `monaco`
- Layout version bumps from `1` → `2` with migration in `LayoutTreeManager.restore()`:
  - `'editor'` → `'neovim'`
  - `'widget'` → removed (treated as `'neovim'` fallback)

---

## 2. Pane Registry (`app/src/browser/panes/`)

All pane type definitions live in a single folder for easy management.

```
app/src/browser/panes/
  index.ts           ← PaneDescriptor interface + PaneRegistry singleton service
  neovim-pane.ts     ← Neovim editor pane (NvimWidget, PTY spawn/kill)
  terminal-pane.ts   ← Terminal pane (NvimWidget in terminal role, PTY spawn/kill)
  monaco-pane.ts     ← Monaco editor pane (Theia EditorWidget)
```

### `PaneDescriptor` interface

```ts
interface PaneDescriptor {
  role: string;                              // unique key, matches LeafNode.role
  label: string;                             // shown in "add pane" picker menu
  icon: string;                              // codicon class (e.g. 'codicon-terminal')
  singleton?: boolean;                       // if true: max one per tab
  create(ctx: PaneContext): Promise<Widget>; // factory called by TilingContainer
  destroy?(widget: Widget): void;            // cleanup (kill PTY, dispose, etc.)
}

interface PaneContext {
  instanceId: string;   // stable UUID for this leaf
  role: string;
  container: interfaces.Container; // InversifyJS container for DI
}
```

### `PaneRegistry` service

- Singleton, registered in `mineo-frontend-module.ts`
- `register(descriptor: PaneDescriptor): void`
- `get(role: string): PaneDescriptor | undefined`
- `getAll(): PaneDescriptor[]` — used to populate the pane type picker menu
- `canAdd(tabId: string, role: string, layoutTreeManager: LayoutTreeManager): boolean` — enforces `singleton` constraint

All pane descriptors are registered at module load time in `mineo-frontend-module.ts`.

---

## 3. Remove ModeService

The following are deleted entirely:

- `app/src/browser/mode-service.ts`
- `EditorModeStatusBarContribution` (NEOVIM/MONACO status bar toggle)
- `NvimTerminalContribution.activateNeovimMode()` / `activateMonacoMode()`
- `ModeActivator` interface
- `when: 'mineoNeovimMode'` context key from all keybindings in `TilingCommandContribution`
- All `modeService.activate()` calls in `TilingLayoutService`

`NvimTerminalContribution.onStart()` simplifies to: wait for `ready` state → `buildInitialLayout()` → start buffer watch.

Tiling commands (split, close, navigate, tab ops) become always active — no `when` guard needed.

`NvimOpenHandler`:
- Always returns priority `500` for `file://` URIs (no mode check)
- Targets focused pane's `instanceId` if it is a `neovim` role leaf, otherwise falls back to the first `neovim` leaf in the active tab

Sidebar stays unchanged: `leftPanelSize: 240`. `FileNavigatorWidget` remains in the left panel and opens files via `NvimOpenHandler` into the focused neovim pane.

---

## 4. Pane Header Bar

Each pane gets a thin header bar rendered inside `TilingContainer.createLeafWidget()`, replacing the current `.mineo-pane-drag-handle`.

```
[≡] [icon] [Label]                    [⊞] [⊟] [×]
```

| Element | Description |
|---|---|
| `≡` | Drag handle — existing drag-and-drop behavior |
| `icon + label` | Pane type indicator (e.g. `$(terminal) Terminal`) |
| `⊞` | Split horizontal button → shows pane type picker |
| `⊟` | Split vertical button → shows pane type picker |
| `×` | Close button — closes pane; closes tab if last pane |

### Pane type picker menu

- Appears below the split button that was clicked
- Lists all registered pane types with icon + label
- If `singleton` pane type already exists in the tab, its entry is grayed out/disabled
- Selecting a type calls `TilingLayoutService.splitFocusedPane(direction, role)`

### CSS

- `app/src/browser/style/panes.css` — new file for header bar, picker menu
- `.mineo-pane-drag-handle` in `tiling.css` replaced by `.mineo-pane-header`

---

## 5. TilingContainer Changes

- `createLeafWidget()` calls `PaneRegistry.get(leaf.role).create(ctx)` instead of hardcoded `NvimWidgetFactory`
- `handleClose()` calls `PaneRegistry.get(leaf.role).destroy(widget)` instead of hardcoded PTY kill
- `focusLeaf()` calls `widget.activate()` for all pane types (no `instanceof NvimWidget` branch)
- `onResize()` / `onAfterShow()` — only call `fitAndResize()` on widgets that are `instanceof NvimWidget` (neovim/terminal panes)
- Static `widgetPool` stays — keyed by `instanceId`, reused across drag operations for all pane types

---

## 6. What Does NOT Change

- `LayoutTreeManager` — tree mutations, persistence, focus tracking, navigation all unchanged
- `SplitPanel` / Lumino layout — unchanged
- `PtyControlService` — unchanged, used by neovim/terminal pane descriptors
- `TilingCommandContribution` keybindings — same shortcuts, just no `when` guard
- Drag-and-drop between panes/tabs — unchanged
- Tab management — unchanged

---

## File Checklist

| File | Action |
|---|---|
| `app/src/common/layout-types.ts` | Update `PaneRole`, remove `widgetId`, bump version |
| `app/src/browser/panes/index.ts` | New — `PaneDescriptor`, `PaneRegistry` |
| `app/src/browser/panes/neovim-pane.ts` | New — neovim descriptor |
| `app/src/browser/panes/terminal-pane.ts` | New — terminal descriptor |
| `app/src/browser/panes/monaco-pane.ts` | New — monaco descriptor |
| `app/src/browser/tiling-container.ts` | Use `PaneRegistry`, add pane header, remove mode guards |
| `app/src/browser/tiling-layout-service.ts` | Remove `ModeService` calls, use `PaneRegistry.canAdd` |
| `app/src/browser/layout-tree-manager.ts` | Version migration `1→2` |
| `app/src/browser/mineo-frontend-module.ts` | Register `PaneRegistry`, remove `ModeService`, register pane descriptors |
| `app/src/browser/mode-service.ts` | Delete |
| `app/src/browser/style/panes.css` | New — pane header + picker styles |
| `app/src/browser/style/tiling.css` | Remove drag handle styles |
| `app/src/browser/nvim-widget-factory.ts` | Keep — used internally by neovim/terminal pane descriptors |
