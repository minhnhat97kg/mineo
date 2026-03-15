# Golden-Layout Integration Design

**Date:** 2026-03-15
**Status:** Approved

## Summary

Replace the pure React tab container in `LayoutContainer.tsx` with golden-layout v2,
using embedded (non-virtual) components via `registerComponentFactoryFunction`.
Full GL features enabled: drag-and-drop tabs, split panes, splitter resize, popout
windows, maximize/minimize.

## Decisions

- **Binding approach:** Embedded (non-virtual) — xterm is already imperative, no React
  DOM benefits.
- **Layout persistence:** Structure only — save layout shape to localStorage on
  `beforeunload`, restore on load. Each component gets a fresh `instanceId` and PTY on
  every load. Clear saved layout on parse errors.
- **Default layout:** Single neovim pane in a stack.
- **Theme:** golden-layout dark theme + CSS overrides to match `#0d0d17` background.

## Architecture

### Component Registration

Register two component types with `GoldenLayout`:

- `'neovim'` — spawns neovim PTY, connects xterm
- `'terminal'` — spawns shell PTY, connects xterm

Factory function for each:
1. Creates a container `<div>`
2. Instantiates xterm `Terminal` + `FitAddon`
3. Spawns PTY via `ptyControlService.spawn()`
4. Connects data/resize WebSockets after spawn ack
5. Sets up `ResizeObserver` for fit-on-resize
6. Returns cleanup function via `beforeComponentRelease` event

### Layout Persistence (structure only)

- `beforeunload` → `gl.saveLayout()` → strip `componentState` → `localStorage`
- On load → `localStorage.getItem` → `LayoutConfig.fromResolved()` → `loadLayout()`
- Fresh `instanceId` + PTY per component on every load

### Adding Panes

`LayoutContainerHandle.addPane(role)` calls `gl.addComponent(role)`.

## Files Changed

| File | Change |
|------|--------|
| `client/src/LayoutContainer.tsx` | Full rewrite — GL setup, component factories, addPane |
| `client/src/XtermPane.tsx` | Delete — logic absorbed into LayoutContainer |
| `client/src/main.tsx` | Add GL CSS imports |
| `client/src/style/main.css` | Remove `.lc-*` styles, add GL theme overrides |
| `client/src/App.tsx` | No change |
| `client/src/Toolbar.tsx` | No change |
| `client/src/pty-control-service.ts` | No change |
