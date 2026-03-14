# Generic Pane System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the tiling system to support parallel pane types (neovim, terminal, monaco) via a `panes/` registry, remove the global ModeService toggle, and add a pane header bar with split/close buttons.

**Architecture:** A `PaneRegistry` singleton holds `PaneDescriptor` objects — one per pane type — each with `create`/`destroy` factories. `TilingContainer` delegates all widget creation and cleanup to the registry. The global `ModeService` is deleted; tiling commands become always-active.

**Tech Stack:** TypeScript, Theia framework, Lumino widgets, InversifyJS DI, xterm.js (neovim/terminal panes), Monaco editor (monaco pane).

---

## Task 1: Update Data Model

**Files:**
- Modify: `app/src/common/layout-types.ts`

**Step 1: Update the file**

Replace the entire contents of `app/src/common/layout-types.ts` with:

```ts
/**
 * Shared types for the tmux-like tiling layout system.
 */

/** UUID v4 string identifying a PTY instance (or stable widget key). */
export type PtyInstanceId = string;

/** What a pane renders. Must match a registered PaneDescriptor.role. */
export type PaneRole = 'neovim' | 'terminal' | 'monaco';

/** A leaf node in the layout tree — one pane. */
export interface LeafNode {
    type: 'leaf';
    id: string;
    role: PaneRole;
    instanceId: PtyInstanceId;
}

/** A split node containing two or more children arranged in a direction. */
export interface SplitNode {
    type: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    children: LayoutNode[];
    /** Relative sizes, e.g. [0.5, 0.5]. Must sum to ~1.0 and match children.length. */
    sizes: number[];
}

/** A node in the layout tree — either a leaf pane or a split container. */
export type LayoutNode = LeafNode | SplitNode;

/** Layout for a single tab — one root node (leaf or split). */
export interface TabLayout {
    id: string;
    label: string;
    root: LayoutNode;
}

/** Serializable workspace layout — the entire tiling state. */
export interface WorkspaceLayout {
    version: 1 | 2;
    activeTabIndex: number;
    tabs: TabLayout[];
}
```

**Step 2: Commit**

```bash
git add app/src/common/layout-types.ts
git commit -m "refactor(types): expand PaneRole, remove widgetId, add version 2"
```

---

## Task 2: Add Layout Version Migration

**Files:**
- Modify: `app/src/browser/layout-tree-manager.ts`

**Step 1: Update `defaultLayout` to version 2 and add migration in `restore()`**

In `layout-tree-manager.ts`, change `defaultLayout()` to return `version: 2`, and update `restore()` to migrate v1 layouts:

```ts
/** Create a default layout: one tab with one neovim pane. */
function defaultLayout(): WorkspaceLayout {
    return {
        version: 2,
        activeTabIndex: 0,
        tabs: [{
            id: uuid(),
            label: 'Tab 1',
            root: {
                type: 'leaf',
                id: uuid(),
                role: 'neovim',
                instanceId: uuid(),
            },
        }],
    };
}
```

In the `restore()` method, after parsing the stored JSON and before returning it, add a migration step. Find the block that starts `if (layout.version === 1 && ...)` and expand it:

```ts
private restore(): WorkspaceLayout {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const layout = JSON.parse(stored) as WorkspaceLayout;
            if ((layout.version === 1 || layout.version === 2) && layout.tabs && layout.tabs.length > 0) {
                // Migrate v1: 'editor' → 'neovim', 'widget' → 'neovim'
                if (layout.version === 1) {
                    for (const tab of layout.tabs) {
                        migrateV1Roles(tab.root);
                    }
                    layout.version = 2;
                }
                // Regenerate instanceIds — PTYs are dead after page refresh
                for (const tab of layout.tabs) {
                    regenerateInstanceIds(tab.root);
                }
                if (layout.activeTabIndex < 0 || layout.activeTabIndex >= layout.tabs.length) {
                    layout.activeTabIndex = 0;
                }
                return layout;
            }
        }
    } catch {
        // Corrupt data — use default
    }
    return defaultLayout();
}
```

Add the migration helper function near the top of the file (after `regenerateInstanceIds`):

```ts
/** Migrate v1 role names to v2. */
function migrateV1Roles(node: LayoutNode): void {
    if (node.type === 'leaf') {
        if ((node.role as string) === 'editor') node.role = 'neovim';
        if ((node.role as string) === 'widget') node.role = 'neovim';
    } else {
        for (const child of node.children) {
            migrateV1Roles(child);
        }
    }
}
```

Also update `addTab()` and `splitPane()` — change default role from `'editor'` to `'neovim'`:

In `addTab()`:
```ts
addTab(role: PaneRole = 'neovim'): TabLayout {
```

In `splitPane()`:
```ts
splitPane(
    tabId: string,
    leafId: string,
    direction: 'horizontal' | 'vertical',
    newRole: PaneRole = 'neovim',
    ratio: number = 0.5,
): LeafNode | null {
```

**Step 2: Commit**

```bash
git add app/src/browser/layout-tree-manager.ts
git commit -m "refactor(layout): migrate v1→v2, default role 'editor'→'neovim'"
```

---

## Task 3: Create the PaneRegistry

**Files:**
- Create: `app/src/browser/panes/index.ts`

**Step 1: Create the file**

```ts
/**
 * PaneRegistry — maps pane role strings to PaneDescriptor objects.
 * All pane type definitions live in app/src/browser/panes/ for easy management.
 */

import { injectable } from '@theia/core/shared/inversify';
import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { interfaces } from '@theia/core/shared/inversify';
import { LayoutTreeManager } from '../layout-tree-manager';
import type { PaneRole } from '../../common/layout-types';

export interface PaneContext {
    instanceId: string;
    role: string;
    diContainer: interfaces.Container;
}

export interface PaneDescriptor {
    /** Unique key — must match LeafNode.role values. */
    role: string;
    /** Human-readable name shown in the pane type picker. */
    label: string;
    /** Codicon CSS class, e.g. 'codicon codicon-terminal'. */
    icon: string;
    /** If true, only one pane of this type is allowed per tab. */
    singleton?: boolean;
    /** Create the widget for this pane. Called by TilingContainer. */
    create(ctx: PaneContext): Promise<Widget>;
    /** Cleanup when pane is closed. Kill PTY, dispose resources, etc. */
    destroy?(widget: Widget, instanceId: string): void;
}

@injectable()
export class PaneRegistry {
    private readonly descriptors = new Map<string, PaneDescriptor>();

    register(descriptor: PaneDescriptor): void {
        this.descriptors.set(descriptor.role, descriptor);
    }

    get(role: string): PaneDescriptor | undefined {
        return this.descriptors.get(role);
    }

    getAll(): PaneDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    /**
     * Returns true if a pane of the given role can be added to the given tab.
     * Enforces the singleton constraint.
     */
    canAdd(tabId: string, role: string, layoutTreeManager: LayoutTreeManager): boolean {
        const descriptor = this.descriptors.get(role);
        if (!descriptor?.singleton) return true;
        const leaves = layoutTreeManager.getTabLeaves(tabId);
        return !leaves.some(l => l.role === role);
    }
}
```

**Step 2: Commit**

```bash
git add app/src/browser/panes/index.ts
git commit -m "feat(panes): add PaneRegistry and PaneDescriptor interface"
```

---

## Task 4: Create Neovim Pane Descriptor

**Files:**
- Create: `app/src/browser/panes/neovim-pane.ts`

**Step 1: Create the file**

```ts
/**
 * neovim-pane — PaneDescriptor for the Neovim editor pane.
 * Creates a NvimWidget and spawns a neovim PTY via PtyControlService.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { NvimWidget } from '../neovim-widget';
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
import type { PaneDescriptor, PaneContext } from './index';

export const neovimPaneDescriptor: PaneDescriptor = {
    role: 'neovim',
    label: 'Neovim Editor',
    icon: 'codicon codicon-terminal',

    async create(ctx: PaneContext): Promise<Widget> {
        const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
        const ptyService = ctx.diContainer.get(PtyControlService);

        const widget = factory({ instanceId: ctx.instanceId, role: 'neovim' });

        const hash = window.location.hash.replace(/^#/, '');
        const cwd = hash.startsWith('/') ? hash : undefined;
        await ptyService.spawn(ctx.instanceId, 'neovim', 120, 30, cwd);
        widget.connectChannels();

        return widget;
    },

    destroy(widget: Widget, instanceId: string): void {
        const ptyService = (widget as any)._ptyService as PtyControlService | undefined;
        // PtyControlService is available via the pane context at destroy time;
        // the caller (TilingContainer) passes instanceId for cleanup.
        // TilingContainer handles PTY kill directly using PtyControlService.
        if (widget instanceof NvimWidget) {
            widget.dispose();
        }
    },
};
```

**Step 2: Commit**

```bash
git add app/src/browser/panes/neovim-pane.ts
git commit -m "feat(panes): add neovim pane descriptor"
```

---

## Task 5: Create Terminal Pane Descriptor

**Files:**
- Create: `app/src/browser/panes/terminal-pane.ts`

**Step 1: Create the file**

```ts
/**
 * terminal-pane — PaneDescriptor for the terminal pane.
 * Creates a NvimWidget in terminal role and spawns a shell PTY.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { NvimWidget } from '../neovim-widget';
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
import type { PaneDescriptor, PaneContext } from './index';

export const terminalPaneDescriptor: PaneDescriptor = {
    role: 'terminal',
    label: 'Terminal',
    icon: 'codicon codicon-terminal-bash',

    async create(ctx: PaneContext): Promise<Widget> {
        const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
        const ptyService = ctx.diContainer.get(PtyControlService);

        const widget = factory({ instanceId: ctx.instanceId, role: 'terminal' });

        const hash = window.location.hash.replace(/^#/, '');
        const cwd = hash.startsWith('/') ? hash : undefined;
        await ptyService.spawn(ctx.instanceId, 'terminal', 120, 30, cwd);
        widget.connectChannels();

        return widget;
    },

    destroy(widget: Widget, _instanceId: string): void {
        if (widget instanceof NvimWidget) {
            widget.dispose();
        }
    },
};
```

**Step 2: Commit**

```bash
git add app/src/browser/panes/terminal-pane.ts
git commit -m "feat(panes): add terminal pane descriptor"
```

---

## Task 6: Create Monaco Pane Descriptor

**Files:**
- Create: `app/src/browser/panes/monaco-pane.ts`

**Step 1: Create the file**

```ts
/**
 * monaco-pane — PaneDescriptor for the Monaco editor pane.
 * Creates a Theia EditorWidget via EditorManager.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { EditorManager } from '@theia/editor/lib/browser';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import URI from '@theia/core/lib/common/uri';
import type { PaneDescriptor, PaneContext } from './index';

export const monacoPaneDescriptor: PaneDescriptor = {
    role: 'monaco',
    label: 'Monaco Editor',
    icon: 'codicon codicon-edit',

    async create(ctx: PaneContext): Promise<Widget> {
        const editorManager = ctx.diContainer.get(EditorManager);

        // Open an untitled file in monaco — uses instanceId as unique URI segment
        const uri = new URI(`untitled:///${ctx.instanceId}`);
        const editorWidget = await editorManager.getOrCreateByUri(uri) as EditorWidget;

        return editorWidget;
    },

    destroy(widget: Widget, _instanceId: string): void {
        widget.dispose();
    },
};
```

**Step 2: Commit**

```bash
git add app/src/browser/panes/monaco-pane.ts
git commit -m "feat(panes): add monaco pane descriptor"
```

---

## Task 7: Add Pane Header CSS

**Files:**
- Create: `app/src/browser/style/panes.css`
- Modify: `app/src/browser/style/tiling.css`

**Step 1: Create `panes.css`**

```css
/* ── Pane Header Bar ──────────────────────────────────────────────────────── */

.mineo-pane-header {
    display: flex;
    align-items: center;
    height: 24px;
    min-height: 24px;
    padding: 0 4px;
    background: rgba(17, 17, 27, 0.6);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    gap: 4px;
    z-index: 10;
    flex-shrink: 0;
    user-select: none;
    cursor: default;
}

/* Drag grip — leftmost element */
.mineo-pane-header-drag {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 100%;
    cursor: grab;
    color: rgba(205, 214, 244, 0.2);
    font-size: 12px;
    flex-shrink: 0;
    transition: color 0.15s;
}

.mineo-pane-header-drag:hover {
    color: rgba(205, 214, 244, 0.55);
}

.mineo-pane-header-drag:active {
    cursor: grabbing;
}

/* Icon + label */
.mineo-pane-header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    font-size: 12px;
    color: rgba(205, 214, 244, 0.4);
    flex-shrink: 0;
}

.mineo-pane-header-label {
    font-size: 10px;
    font-weight: 500;
    color: rgba(205, 214, 244, 0.4);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Right-side action buttons */
.mineo-pane-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
}

.mineo-pane-header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: rgba(205, 214, 244, 0.3);
    font-size: 11px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
}

.mineo-pane-header-btn:hover {
    color: rgba(205, 214, 244, 0.85);
    background: rgba(255, 255, 255, 0.07);
}

.mineo-pane-header-btn--close:hover {
    color: rgba(243, 139, 168, 0.9);
    background: rgba(243, 139, 168, 0.1);
}

/* Pane content area — fills remaining space below header */
.mineo-pane-content {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
}

/* Wrapper that holds header + content together */
.mineo-pane-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
}

/* Active pane outline on the wrapper */
.mineo-pane-wrapper.mineo-pane-active {
    box-shadow: inset 0 0 0 1px rgba(53, 116, 240, 0.3);
}

.mineo-pane-wrapper.mineo-pane-close-preview {
    box-shadow: inset 0 0 0 1px rgba(243, 139, 168, 0.5) !important;
}

/* Active pane — brighten header label and icon */
.mineo-pane-wrapper.mineo-pane-active .mineo-pane-header-label,
.mineo-pane-wrapper.mineo-pane-active .mineo-pane-header-icon {
    color: rgba(205, 214, 244, 0.65);
}

/* ── Pane Type Picker Menu ────────────────────────────────────────────────── */

.mineo-pane-picker {
    position: fixed;
    z-index: 9999;
    min-width: 180px;
    padding: 4px 0;
    background: rgba(24, 24, 37, 0.96);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font-size: 12px;
    user-select: none;
}

.mineo-pane-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    color: rgba(205, 214, 244, 0.75);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
}

.mineo-pane-picker-item:hover:not(.mineo-pane-picker-item--disabled) {
    background: rgba(255, 255, 255, 0.07);
    color: rgba(205, 214, 244, 0.95);
}

.mineo-pane-picker-item--disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

.mineo-pane-picker-item-icon {
    width: 14px;
    height: 14px;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(205, 214, 244, 0.5);
    flex-shrink: 0;
}
```

**Step 2: Remove drag handle styles from `tiling.css`**

Remove the following block from `app/src/browser/style/tiling.css` (lines 312–338):

```css
/* ── Pane Drag-to-Move ────────────────────────────────────────────────────── */

/* Drag handle — thin bar at the top of every pane */
.mineo-pane-drag-handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    z-index: 10;
    cursor: grab;
    background: transparent;
    transition: background 0.15s;
}

.mineo-pane-drag-handle:hover {
    background: rgba(53, 116, 240, 0.25);
}

.mineo-pane-drag-handle:active {
    cursor: grabbing;
}

/* Make sure NvimWidget has relative positioning so the handle sits correctly */
.nvim-widget {
    position: relative;
}
```

Also update the `.mineo-pane-active` and `.mineo-pane-close-preview` rules in `tiling.css` — remove them (they move to `panes.css` on the `.mineo-pane-wrapper` selector).

**Step 3: Commit**

```bash
git add app/src/browser/style/panes.css app/src/browser/style/tiling.css
git commit -m "feat(styles): add pane header CSS, remove old drag handle styles"
```

---

## Task 8: Rewrite TilingContainer

**Files:**
- Modify: `app/src/browser/tiling-container.ts`

This is the largest change. The goal: replace all hardcoded `NvimWidget` logic with `PaneRegistry` calls, wrap each leaf in a `.mineo-pane-wrapper` div containing a header + content area, move drag handle to the header.

**Step 1: Replace the entire file**

Key changes from the current implementation:
1. Accept `PaneRegistry` and `diContainer` as constructor args (in addition to existing args)
2. `createLeafWidget()` → creates a wrapper `div`-based widget containing header + content, calls `paneRegistry.get(leaf.role).create(ctx)` for the inner widget
3. `handleClose()` → calls `paneRegistry.get(role)?.destroy(widget, instanceId)` then kills PTY via `PtyControlService` for PTY-backed panes
4. `focusLeaf()` → calls `widget.activate()` or `NvimWidget.focusTerminal()` based on instanceof check (no change to logic, just cleaner)
5. `setupPaneDrag()` → moved to drag grip element in header, not the whole widget node
6. Header contains: drag grip `≡`, icon span, label span, split-H button `⊞`, split-V button `⊟`, close button `×`
7. Split/close buttons in header call a callback (`onSplitRequest`, `onCloseRequest`) injected at construction time — `TilingLayoutService` provides these
8. Pane type picker rendered inline using `PaneRegistry.getAll()`

The wrapper approach: instead of using the `NvimWidget` node directly as the pane, we create a `BaseWidget` subclass called `PaneWrapper` that:
- Has a flex column layout: `header (24px) + content (flex: 1)`
- The inner widget from `PaneDescriptor.create()` is appended to the content div
- `PaneWrapper` receives resize/focus messages and forwards them to the inner widget

```ts
/**
 * TilingContainer — renders one tab's split tree using nested SplitPanels.
 * Pane creation is delegated to PaneRegistry.
 */

import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget, BaseWidget, Message } from '@theia/core/lib/browser/widgets/widget';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { SplitPanel, SplitLayout, BoxLayout } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import { interfaces } from '@theia/core/shared/inversify';
import { NvimWidget } from './neovim-widget';
import { PtyControlService } from './pty-control-service';
import { LayoutTreeManager } from './layout-tree-manager';
import { PaneRegistry } from './panes/index';
import type { LayoutNode, LeafNode, SplitNode, TabLayout } from '../common/layout-types';

// ── Pane drag state ───────────────────────────────────────────────────────────
interface PaneDragState {
    srcLeafId: string;
    srcTabId: string;
    srcContainer: TilingContainer;
}
let _paneDrag: PaneDragState | null = null;

type DropZone = 'left' | 'right' | 'top' | 'bottom';

function getDropZone(e: DragEvent, el: HTMLElement): DropZone {
    const r = el.getBoundingClientRect();
    const rx = (e.clientX - r.left) / r.width;
    const ry = (e.clientY - r.top) / r.height;
    if (rx < ry && rx < 1 - ry) return 'left';
    if (rx > ry && rx > 1 - ry) return 'right';
    if (ry < 0.5) return 'top';
    return 'bottom';
}

/**
 * PaneWrapper — a BaseWidget that wraps an inner widget with a pane header.
 * Layout: flex column — 24px header + flex:1 content.
 */
class PaneWrapper extends BaseWidget {
    private readonly headerEl: HTMLElement;
    private readonly contentEl: HTMLElement;
    private innerWidget: Widget | undefined;

    constructor(
        private readonly leafId: string,
        private readonly leaf: LeafNode,
        private readonly paneRegistry: PaneRegistry,
        private readonly onSplitH: () => void,
        private readonly onSplitV: () => void,
        private readonly onClose: () => void,
        private readonly onFocus: () => void,
    ) {
        super();
        this.id = 'mineo.pane-wrapper.' + leafId;
        this.addClass('mineo-pane-wrapper');
        this.node.style.display = 'flex';
        this.node.style.flexDirection = 'column';
        this.node.style.width = '100%';
        this.node.style.height = '100%';
        this.node.style.overflow = 'hidden';
        this.node.style.position = 'relative';

        // Header
        this.headerEl = document.createElement('div');
        this.headerEl.className = 'mineo-pane-header';
        this.node.appendChild(this.headerEl);

        // Content
        this.contentEl = document.createElement('div');
        this.contentEl.className = 'mineo-pane-content';
        this.node.appendChild(this.contentEl);

        this.buildHeader();

        // Focus tracking
        this.node.addEventListener('mousedown', () => this.onFocus(), true);
    }

    private buildHeader(): void {
        const descriptor = this.paneRegistry.get(this.leaf.role);

        // Drag grip
        const grip = document.createElement('div');
        grip.className = 'mineo-pane-header-drag';
        grip.innerHTML = '&#8801;'; // ≡
        grip.draggable = true;
        this.headerEl.appendChild(grip);
        // Drag events are wired later by TilingContainer.setupPaneDrag()
        this.headerEl.querySelector('.mineo-pane-header-drag')!; // reference for setupPaneDrag

        // Icon
        const icon = document.createElement('span');
        icon.className = `mineo-pane-header-icon ${descriptor?.icon ?? ''}`;
        this.headerEl.appendChild(icon);

        // Label
        const label = document.createElement('span');
        label.className = 'mineo-pane-header-label';
        label.textContent = descriptor?.label ?? this.leaf.role;
        this.headerEl.appendChild(label);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'mineo-pane-header-actions';
        this.headerEl.appendChild(actions);

        // Split horizontal button
        const splitH = document.createElement('button');
        splitH.className = 'mineo-pane-header-btn';
        splitH.title = 'Split horizontal';
        splitH.innerHTML = '&#10564;'; // ⊞
        splitH.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        splitH.addEventListener('click', e => {
            e.stopPropagation();
            this.showPanePicker(splitH, 'horizontal');
        });
        actions.appendChild(splitH);

        // Split vertical button
        const splitV = document.createElement('button');
        splitV.className = 'mineo-pane-header-btn';
        splitV.title = 'Split vertical';
        splitV.innerHTML = '&#10565;'; // ⊟
        splitV.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        splitV.addEventListener('click', e => {
            e.stopPropagation();
            this.showPanePicker(splitV, 'vertical');
        });
        actions.appendChild(splitV);

        // Close button
        const close = document.createElement('button');
        close.className = 'mineo-pane-header-btn mineo-pane-header-btn--close';
        close.title = 'Close pane';
        close.textContent = '×';
        close.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        close.addEventListener('click', e => { e.stopPropagation(); this.onClose(); });
        actions.appendChild(close);
    }

    private showPanePicker(anchor: HTMLElement, direction: 'horizontal' | 'vertical'): void {
        // Remove any existing picker
        document.querySelector('.mineo-pane-picker')?.remove();

        const picker = document.createElement('div');
        picker.className = 'mineo-pane-picker';

        const all = this.paneRegistry.getAll();
        for (const desc of all) {
            const item = document.createElement('div');
            item.className = 'mineo-pane-picker-item';
            item.innerHTML =
                `<span class="mineo-pane-picker-item-icon ${desc.icon}"></span>` +
                `<span>${desc.label}</span>`;
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                picker.remove();
                if (direction === 'horizontal') {
                    this.onSplitH();
                    // role is passed via closure — we need to communicate the chosen role
                    // TilingContainer wires onSplitH/onSplitV with the role baked in via the picker
                }
            });
            picker.appendChild(item);
        }

        document.body.appendChild(picker);
        const rect = anchor.getBoundingClientRect();
        picker.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        picker.style.top = `${rect.bottom + 2}px`;

        const dismiss = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener('mousedown', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    }

    getDragGrip(): HTMLElement {
        return this.headerEl.querySelector('.mineo-pane-header-drag') as HTMLElement;
    }

    setInnerWidget(widget: Widget): void {
        this.innerWidget = widget;
        this.contentEl.appendChild(widget.node);
    }

    getInnerWidget(): Widget | undefined {
        return this.innerWidget;
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        if (this.innerWidget instanceof NvimWidget) {
            requestAnimationFrame(() => this.innerWidget instanceof NvimWidget && this.innerWidget.fitAndResize());
        }
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.innerWidget instanceof NvimWidget) {
            requestAnimationFrame(() => this.innerWidget instanceof NvimWidget && this.innerWidget.fitAndResize());
        }
    }
}

export class TilingContainer extends BaseWidget {
    /** Map from leaf ID → PaneWrapper */
    private wrapperMap = new Map<string, PaneWrapper>();
    /** Map from split ID → SplitPanel */
    private splitMap = new Map<string, SplitPanel>();
    private rootWidget: Widget | undefined;
    private tabLayout: TabLayout;

    private readonly _onPaneCloseRequest = new Emitter<{ tabId: string, leafId: string }>();
    readonly onPaneCloseRequest: Event<{ tabId: string, leafId: string }> = this._onPaneCloseRequest.event;

    private readonly _onSplitRequest = new Emitter<{ leafId: string, direction: 'horizontal' | 'vertical', role: string }>();
    readonly onSplitRequest: Event<{ leafId: string, direction: 'horizontal' | 'vertical', role: string }> = this._onSplitRequest.event;

    constructor(
        tabLayout: TabLayout,
        private readonly paneRegistry: PaneRegistry,
        private readonly ptyControlService: PtyControlService,
        private readonly layoutTreeManager: LayoutTreeManager,
        private readonly shell: ApplicationShell,
        private readonly diContainer: interfaces.Container,
    ) {
        super();
        this.tabLayout = tabLayout;
        this.id = 'mineo.tiling-container.' + tabLayout.id;
        this.title.label = tabLayout.label;
        this.title.closable = true;
        this.addClass('mineo-tiling-container');

        const boxLayout = new BoxLayout();
        (this as any).layout = boxLayout;
    }

    async buildLayout(): Promise<void> {
        this.rootWidget = await this.buildNode(this.tabLayout.root);
        if (this.rootWidget) {
            (this.layout as BoxLayout).addWidget(this.rootWidget);
        }
    }

    private async buildNode(node: LayoutNode, spawnPty = true): Promise<Widget> {
        if (node.type === 'leaf') {
            return this.createLeafWrapper(node, spawnPty);
        } else {
            return this.createSplitWidget(node, spawnPty);
        }
    }

    /** Global pool: instanceId → inner Widget (NvimWidget or other) */
    private static widgetPool = new Map<string, Widget>();

    private async createLeafWrapper(leaf: LeafNode, spawnPty = true): Promise<PaneWrapper> {
        const wrapper = new PaneWrapper(
            leaf.id,
            leaf,
            this.paneRegistry,
            // onSplitH — shows picker, then fires onSplitRequest when type chosen
            () => { /* handled inside PaneWrapper.showPanePicker */ },
            // onSplitV
            () => { /* handled inside PaneWrapper.showPanePicker */ },
            // onClose
            () => this._onPaneCloseRequest.fire({ tabId: this.tabLayout.id, leafId: leaf.id }),
            // onFocus
            () => this.setActivePane(leaf.id),
        );

        // Wire split requests from picker
        this.wireSplitPicker(wrapper, leaf);

        const existing = TilingContainer.widgetPool.get(leaf.instanceId);
        let innerWidget: Widget;

        if (existing) {
            innerWidget = existing;
        } else {
            const descriptor = this.paneRegistry.get(leaf.role);
            if (!descriptor) {
                throw new Error(`No pane descriptor registered for role: ${leaf.role}`);
            }
            if (spawnPty) {
                innerWidget = await descriptor.create({
                    instanceId: leaf.instanceId,
                    role: leaf.role,
                    diContainer: this.diContainer,
                });
            } else {
                // Rebuild path — reuse pool or recreate without PTY spawn
                innerWidget = await descriptor.create({
                    instanceId: leaf.instanceId,
                    role: leaf.role,
                    diContainer: this.diContainer,
                });
            }
            TilingContainer.widgetPool.set(leaf.instanceId, innerWidget);
        }

        wrapper.setInnerWidget(innerWidget);
        this.wrapperMap.set(leaf.id, wrapper);

        // Auto-close on neovim exit
        if (innerWidget instanceof NvimWidget) {
            innerWidget.onExit(() => {
                if (this.wrapperMap.has(leaf.id)) {
                    this._onPaneCloseRequest.fire({ tabId: this.tabLayout.id, leafId: leaf.id });
                }
            });
        }

        this.setupPaneDrag(wrapper, leaf);
        return wrapper;
    }

    /** Wire the pane type picker buttons in the wrapper header to fire split requests. */
    private wireSplitPicker(wrapper: PaneWrapper, leaf: LeafNode): void {
        // Override the picker's item click to fire our event
        const originalShowPicker = wrapper['showPanePicker'].bind(wrapper);
        wrapper['showPanePicker'] = (anchor: HTMLElement, direction: 'horizontal' | 'vertical') => {
            document.querySelector('.mineo-pane-picker')?.remove();

            const picker = document.createElement('div');
            picker.className = 'mineo-pane-picker';

            const activeTabId = this.tabLayout.id;
            for (const desc of this.paneRegistry.getAll()) {
                const canAdd = this.paneRegistry.canAdd(activeTabId, desc.role, this.layoutTreeManager);
                const item = document.createElement('div');
                item.className = 'mineo-pane-picker-item' + (canAdd ? '' : ' mineo-pane-picker-item--disabled');
                item.innerHTML =
                    `<span class="mineo-pane-picker-item-icon ${desc.icon}"></span>` +
                    `<span>${desc.label}</span>`;
                if (canAdd) {
                    item.addEventListener('mousedown', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        picker.remove();
                        this._onSplitRequest.fire({ leafId: leaf.id, direction, role: desc.role });
                    });
                }
                picker.appendChild(item);
            }

            document.body.appendChild(picker);
            const rect = anchor.getBoundingClientRect();
            picker.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
            picker.style.top = `${rect.bottom + 2}px`;

            const dismiss = (e: MouseEvent) => {
                if (!picker.contains(e.target as Node)) {
                    picker.remove();
                    document.removeEventListener('mousedown', dismiss);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
        };
    }

    private async createSplitWidget(split: SplitNode, spawnPty = true): Promise<SplitPanel> {
        const panel = new SplitPanel({
            orientation: split.direction === 'horizontal' ? 'horizontal' : 'vertical',
        });
        panel.id = 'mineo.split.' + split.id;
        panel.addClass('mineo-split-panel');
        this.splitMap.set(split.id, panel);

        for (const child of split.children) {
            const childWidget = await this.buildNode(child, spawnPty);
            panel.addWidget(childWidget);
        }

        requestAnimationFrame(() => panel.setRelativeSizes(split.sizes));
        return panel;
    }

    private setActivePane(leafId: string): void {
        for (const [id, wrapper] of this.wrapperMap) {
            wrapper.node.classList.toggle('mineo-pane-active', id === leafId);
        }
        this.layoutTreeManager.setFocusedLeaf(leafId);
    }

    focusLeaf(leafId: string): void {
        const wrapper = this.wrapperMap.get(leafId);
        if (wrapper) {
            const inner = wrapper.getInnerWidget();
            if (inner instanceof NvimWidget) {
                inner.focusTerminal();
            } else if (inner) {
                inner.activate();
            }
            this.setActivePane(leafId);
        }
    }

    /** Get the wrapper widget for a leaf ID (used by TilingLayoutService context menu). */
    getWidget(leafId: string): Widget | undefined {
        return this.wrapperMap.get(leafId);
    }

    async handleSplit(
        leafId: string,
        newLeaf: LeafNode,
        splitId: string,
        direction: 'horizontal' | 'vertical',
        sizes: number[],
    ): Promise<void> {
        const existingWrapper = this.wrapperMap.get(leafId);
        if (!existingWrapper) return;

        const newWrapper = await this.createLeafWrapper(newLeaf);
        const splitPanel = new SplitPanel({
            orientation: direction === 'horizontal' ? 'horizontal' : 'vertical',
        });
        splitPanel.id = 'mineo.split.' + splitId;
        splitPanel.addClass('mineo-split-panel');
        this.splitMap.set(splitId, splitPanel);

        const parentWidget = existingWrapper.parent;
        if (parentWidget instanceof SplitPanel) {
            const parentLayout = parentWidget.layout as SplitLayout;
            let widgetIndex = -1;
            for (let i = 0; i < parentLayout.widgets.length; i++) {
                if (parentLayout.widgets[i] === existingWrapper) { widgetIndex = i; break; }
            }
            if (widgetIndex >= 0) {
                splitPanel.addWidget(existingWrapper);
                splitPanel.addWidget(newWrapper);
                parentLayout.insertWidget(widgetIndex, splitPanel);
            }
        } else if (parentWidget) {
            const boxLayout = parentWidget.layout;
            if (boxLayout instanceof BoxLayout) {
                splitPanel.addWidget(existingWrapper);
                splitPanel.addWidget(newWrapper);
                boxLayout.addWidget(splitPanel);
                this.rootWidget = splitPanel;
            }
        }

        requestAnimationFrame(() => {
            splitPanel.setRelativeSizes(sizes);
            MessageLoop.sendMessage(existingWrapper, Widget.ResizeMessage.UnknownSize);
            MessageLoop.sendMessage(newWrapper, Widget.ResizeMessage.UnknownSize);
        });
    }

    async handleClose(leafId: string): Promise<void> {
        const wrapper = this.wrapperMap.get(leafId);
        if (!wrapper) return;

        const inner = wrapper.getInnerWidget();
        const leaf = this.layoutTreeManager.findLeaf(leafId);
        if (inner) {
            TilingContainer.widgetPool.delete(leaf?.leaf.instanceId ?? '');
            const descriptor = leaf ? this.paneRegistry.get(leaf.leaf.role) : undefined;
            descriptor?.destroy?.(inner, leaf?.leaf.instanceId ?? '');
            // Kill PTY for PTY-backed panes
            if (leaf && (leaf.leaf.role === 'neovim' || leaf.leaf.role === 'terminal')) {
                this.ptyControlService.kill(leaf.leaf.instanceId).catch(() => {});
            }
        }
        this.wrapperMap.delete(leafId);

        const parentSplit = wrapper.parent;
        if (parentSplit instanceof SplitPanel) {
            wrapper.dispose();
            const splitLayout = parentSplit.layout as SplitLayout;
            if (splitLayout.widgets.length === 1) {
                const survivor = splitLayout.widgets[0];
                const grandParent = parentSplit.parent;
                if (grandParent instanceof SplitPanel) {
                    const gpLayout = grandParent.layout as SplitLayout;
                    let splitIndex = -1;
                    for (let i = 0; i < gpLayout.widgets.length; i++) {
                        if (gpLayout.widgets[i] === parentSplit) { splitIndex = i; break; }
                    }
                    if (splitIndex >= 0) gpLayout.insertWidget(splitIndex, survivor);
                    parentSplit.dispose();
                } else if (grandParent) {
                    const gpBoxLayout = grandParent.layout;
                    if (gpBoxLayout instanceof BoxLayout) {
                        gpBoxLayout.addWidget(survivor);
                        parentSplit.dispose();
                        this.rootWidget = survivor;
                    }
                }
                for (const [id, sp] of this.splitMap) {
                    if (sp === parentSplit) { this.splitMap.delete(id); break; }
                }
            }
            requestAnimationFrame(() => {
                for (const [, w] of this.wrapperMap) {
                    MessageLoop.sendMessage(w, Widget.ResizeMessage.UnknownSize);
                }
            });
        } else {
            wrapper.dispose();
        }
    }

    syncSizesToLayout(): void {
        for (const [splitId, panel] of this.splitMap) {
            const sizes = panel.relativeSizes();
            this.layoutTreeManager.resizeSplit(this.tabLayout.id, splitId, sizes);
        }
    }

    focusFirst(): void {
        const firstLeafId = this.wrapperMap.keys().next().value;
        if (firstLeafId) this.focusLeaf(firstLeafId);
    }

    getInstanceIdForLeaf(leafId: string): string | undefined {
        const found = this.layoutTreeManager.findLeaf(leafId);
        return found?.leaf.instanceId;
    }

    private focusLeafByInstanceId(instanceId: string): void {
        for (const [leafId] of this.wrapperMap) {
            const found = this.layoutTreeManager.findLeaf(leafId);
            if (found?.leaf.instanceId === instanceId) {
                this.focusLeaf(leafId);
                return;
            }
        }
        this.focusFirst();
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        requestAnimationFrame(() => {
            for (const [, wrapper] of this.wrapperMap) {
                const inner = wrapper.getInnerWidget();
                if (inner instanceof NvimWidget) inner.fitAndResize();
            }
        });
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
        this.focusFirst();
        this.layoutTreeManager.setActiveTabById(this.tabLayout.id);
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        requestAnimationFrame(() => {
            for (const [, wrapper] of this.wrapperMap) {
                const inner = wrapper.getInnerWidget();
                if (inner instanceof NvimWidget) inner.fitAndResize();
            }
        });
    }

    private setupPaneDrag(wrapper: PaneWrapper, leaf: LeafNode): void {
        const grip = wrapper.getDragGrip();
        const node = wrapper.node;

        grip.addEventListener('dragstart', (e: DragEvent) => {
            e.stopPropagation();
            _paneDrag = { srcLeafId: leaf.id, srcTabId: this.tabLayout.id, srcContainer: this };
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('application/mineo-pane', leaf.id);
            requestAnimationFrame(() => node.classList.add('mineo-pane-dragging'));
        });

        grip.addEventListener('dragend', (e: DragEvent) => {
            e.stopPropagation();
            _paneDrag = null;
            node.classList.remove('mineo-pane-dragging');
            document.querySelectorAll('.mineo-drop-left,.mineo-drop-right,.mineo-drop-top,.mineo-drop-bottom')
                .forEach(el => el.classList.remove('mineo-drop-left','mineo-drop-right','mineo-drop-top','mineo-drop-bottom'));
        });

        node.addEventListener('dragover', (e: DragEvent) => {
            if (!e.dataTransfer!.types.includes('application/mineo-pane')) return;
            if (!_paneDrag || _paneDrag.srcLeafId === leaf.id) return;
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer!.dropEffect = 'move';
            this.setDropIndicator(node, getDropZone(e, node));
        });

        node.addEventListener('dragleave', (e: DragEvent) => {
            if (!node.contains(e.relatedTarget as Node | null)) this.clearDropIndicator(node);
        });

        node.addEventListener('drop', async (e: DragEvent) => {
            if (!e.dataTransfer!.types.includes('application/mineo-pane')) return;
            e.preventDefault(); e.stopPropagation();
            const drag = _paneDrag; _paneDrag = null;
            document.querySelectorAll('.mineo-drop-left,.mineo-drop-right,.mineo-drop-top,.mineo-drop-bottom')
                .forEach(el => el.classList.remove('mineo-drop-left','mineo-drop-right','mineo-drop-top','mineo-drop-bottom'));
            if (!drag || drag.srcLeafId === leaf.id) return;

            const zone = getDropZone(e, node);
            const srcInstanceId = drag.srcContainer.getInstanceIdForLeaf(drag.srcLeafId);
            const moved = this.layoutTreeManager.movePane(drag.srcTabId, drag.srcLeafId, this.tabLayout.id, leaf.id, zone);
            if (!moved) return;

            drag.srcContainer.syncSizesToLayout();
            if (drag.srcContainer !== this) this.syncSizesToLayout();

            await drag.srcContainer.rebuildLayout();
            if (drag.srcContainer !== this) await this.rebuildLayout();

            requestAnimationFrame(() => this.focusLeafByInstanceId(srcInstanceId ?? ''));
        });
    }

    private setDropIndicator(node: HTMLElement, zone: DropZone): void {
        node.classList.remove('mineo-drop-left','mineo-drop-right','mineo-drop-top','mineo-drop-bottom');
        node.classList.add(`mineo-drop-${zone}`);
    }

    private clearDropIndicator(node: HTMLElement): void {
        node.classList.remove('mineo-drop-left','mineo-drop-right','mineo-drop-top','mineo-drop-bottom');
    }

    private detachWidgetsFromLumino(widget: Widget): void {
        if (widget instanceof PaneWrapper || widget instanceof NvimWidget) {
            widget.parent = null;
        } else if (widget instanceof SplitPanel) {
            const children = Array.from(widget.widgets);
            for (const child of children) this.detachWidgetsFromLumino(child);
            widget.parent = null;
        }
    }

    async rebuildLayout(): Promise<void> {
        if (this.rootWidget) {
            this.rootWidget.parent = null;
            this.detachWidgetsFromLumino(this.rootWidget);
            this.rootWidget.dispose();
            this.rootWidget = undefined;
        }
        this.wrapperMap.clear();
        this.splitMap.clear();

        const freshTab = this.layoutTreeManager.layout.tabs.find(t => t.id === this.tabLayout.id);
        if (freshTab) this.tabLayout = freshTab;

        this.rootWidget = await this.buildNode(this.tabLayout.root, false);
        if (this.rootWidget) {
            const layout = this.layout as BoxLayout;
            while (layout.widgets.length > 0) layout.widgets[0].dispose();
            layout.addWidget(this.rootWidget);
        }

        requestAnimationFrame(() => {
            for (const [, w] of this.wrapperMap) {
                const inner = w.getInnerWidget();
                if (inner instanceof NvimWidget) inner.fitAndResize();
            }
        });
    }

    override dispose(): void {
        for (const [leafId, wrapper] of this.wrapperMap) {
            if (!this.layoutTreeManager.findLeaf(leafId)) {
                const inner = wrapper.getInnerWidget();
                const found = this.layoutTreeManager.findLeaf(leafId);
                if (inner && found) {
                    TilingContainer.widgetPool.delete(found.leaf.instanceId);
                    const descriptor = this.paneRegistry.get(found.leaf.role);
                    descriptor?.destroy?.(inner, found.leaf.instanceId);
                    if (found.leaf.role === 'neovim' || found.leaf.role === 'terminal') {
                        this.ptyControlService.kill(found.leaf.instanceId).catch(() => {});
                    }
                }
                wrapper.dispose();
            }
        }
        this.wrapperMap.clear();
        this.splitMap.clear();
        super.dispose();
    }
}
```

**Step 2: Commit**

```bash
git add app/src/browser/tiling-container.ts
git commit -m "feat(tiling): rewrite TilingContainer with PaneRegistry and pane header"
```

---

## Task 9: Update TilingLayoutService

**Files:**
- Modify: `app/src/browser/tiling-layout-service.ts`

**Step 1: Remove ModeService, wire PaneRegistry and split requests**

Key changes:
1. Remove `@inject(ModeService)` and all `modeService.activate()` calls
2. Accept `PaneRegistry` as an injected dependency
3. Pass `diContainer` to `TilingContainer` constructor
4. Listen to `container.onSplitRequest` to handle picker-initiated splits
5. Update `splitFocusedPane` signature — role is now `string` not `'editor' | 'terminal'`
6. Update `addNewTab()` to use `'neovim'` as default role
7. Update the context menu "Add Terminal" to use `'terminal'` and add entries for other pane types

Remove this import:
```ts
import { ModeService } from './mode-service';
```

Add this import:
```ts
import { PaneRegistry } from './panes/index';
import { interfaces } from '@theia/core/shared/inversify';
```

Add injection:
```ts
@inject(PaneRegistry) private readonly paneRegistry!: PaneRegistry;
@inject('DIContainer') private readonly diContainer!: interfaces.Container;
```

In `createTab()`, update TilingContainer constructor call:
```ts
const container = new TilingContainer(
    tabLayout,
    this.paneRegistry,
    this.ptyControlService,
    this.layoutTreeManager,
    this.shell,
    this.diContainer,
);
```

After creating the container, wire split requests:
```ts
container.onSplitRequest(({ leafId, direction, role }) => {
    this.splitPaneByLeafId(this.getTabIdForContainer(container), leafId, direction, role);
});
```

Add helper:
```ts
private getTabIdForContainer(container: TilingContainer): string {
    for (const [tabId, c] of this.containers) {
        if (c === container) return tabId;
    }
    return '';
}

async splitPaneByLeafId(tabId: string, leafId: string, direction: 'horizontal' | 'vertical', role: string): Promise<void> {
    if (!tabId || !leafId) return;
    const container = this.containers.get(tabId);
    if (!container) return;

    const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, direction, role as any);
    if (!newLeaf) return;

    const tab = this.layoutTreeManager.layout.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const splitNode = this.findSplitContaining(tab.root, newLeaf.id);
    if (!splitNode) return;

    await container.handleSplit(leafId, newLeaf, splitNode.id, direction, splitNode.sizes);
    requestAnimationFrame(() => container.focusLeaf(newLeaf.id));
}
```

Remove all `await this.modeService.activate('neovim', ...)` calls from:
- `splitFocusedPane()`
- `closeFocusedPane()`
- `openFileInNewPane()`

Update `splitFocusedPane` signature:
```ts
async splitFocusedPane(direction: 'horizontal' | 'vertical', role: string = 'neovim'): Promise<void> {
```

Update context menu to show all registered pane types dynamically instead of hardcoded terminal entry:
```ts
// Replace hardcoded "Add Terminal" with dynamic pane type entries
for (const desc of this.paneRegistry.getAll()) {
    addItem(`Add ${desc.label}`, '', () => this.splitFocusedPane('vertical', desc.role));
}
```

**Step 2: Commit**

```bash
git add app/src/browser/tiling-layout-service.ts
git commit -m "refactor(tiling-service): remove ModeService, wire PaneRegistry and split requests"
```

---

## Task 10: Update mineo-frontend-module.ts

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Step 1: Remove ModeService, register PaneRegistry and pane descriptors**

Remove these imports:
```ts
import { ModeService, ModeActivator, EditorMode } from './mode-service';
```

Add these imports:
```ts
import { PaneRegistry } from './panes/index';
import { neovimPaneDescriptor } from './panes/neovim-pane';
import { terminalPaneDescriptor } from './panes/terminal-pane';
import { monacoPaneDescriptor } from './panes/monaco-pane';
```

Remove these bindings from the ContainerModule:
```ts
// DELETE:
bind(ModeService).toSelf().inSingletonScope();
// DELETE: EditorModeStatusBarContribution and its bind
bind(FrontendApplicationContribution).to(EditorModeStatusBarContribution).inSingletonScope();
```

Add PaneRegistry binding and descriptor registration:
```ts
// PaneRegistry — maps role strings to pane descriptors
bind(PaneRegistry).toSelf().inSingletonScope();

// Register pane descriptors (runs at startup)
bind(FrontendApplicationContribution).toDynamicValue(ctx => {
    const registry = ctx.container.get(PaneRegistry);
    registry.register(neovimPaneDescriptor);
    registry.register(terminalPaneDescriptor);
    registry.register(monacoPaneDescriptor);
    // Return a no-op FrontendApplicationContribution
    return { onStart: () => {} };
}).inSingletonScope();

// Expose DI container for TilingLayoutService → TilingContainer
bind('DIContainer').toConstantValue(container); // 'container' is the bind() parameter's container
```

> Note: To expose the DI container itself, use the `interfaces.Context` pattern. In a ContainerModule, the `bind` callback receives `(bind, unbind, isBound, rebind)`. To get the container reference, use: `bind('DIContainer').toDynamicValue(ctx => ctx.container).inSingletonScope();`

Simplify `NvimTerminalContribution`:
- Remove `ModeActivator` implementation
- Remove `activateNeovimMode()` and `activateMonacoMode()` methods
- Remove `modeService.registerActivator(this)` call
- Remove `nvimModeKey` context key creation
- Simplify `onStart()`:

```ts
onStart(): void {
    window.addEventListener('beforeunload', () => {
        this.tilingLayoutService.saveAllSizes();
    });

    this.stateService.reachedState('ready').then(() => {
        this.tilingLayoutService.buildInitialLayout()
            .then(() => this._startBufferWatch())
            .catch(err => this.messageService.error('Mineo: failed to build layout: ' + err));
    });
}
```

Remove `EditorModeStatusBarContribution` class entirely.

Update `NvimOpenHandler.canHandle()` — remove mode check:
```ts
canHandle(uri: URI): number {
    if (uri.scheme !== 'file') return -1;
    return 500;
}
```

Remove `@inject(ModeService)` from `NvimOpenHandler`.

Update keybindings in `TilingCommandContribution` import — no changes needed to `tiling-commands.ts` itself in this task, but remove `ModeService` from it if it was imported (it wasn't).

Import panes.css in the module:
```ts
import '../../src/browser/style/panes.css';
```

**Step 2: Commit**

```bash
git add app/src/browser/mineo-frontend-module.ts
git commit -m "refactor(module): remove ModeService, register PaneRegistry and pane descriptors"
```

---

## Task 11: Remove ModeService and Update TilingCommands

**Files:**
- Delete: `app/src/browser/mode-service.ts`
- Modify: `app/src/browser/tiling-commands.ts`

**Step 1: Delete mode-service.ts**

```bash
rm app/src/browser/mode-service.ts
```

**Step 2: Remove `when` guard from all keybindings in `tiling-commands.ts`**

In `registerKeybindings()`, remove `const when = 'mineoNeovimMode';` and remove `when` from every `registerKeybinding()` call. Each keybinding becomes:

```ts
keybindings.registerKeybinding({
    command: TilingCommands.SPLIT_HORIZONTAL.id,
    keybinding: 'ctrlcmd+shift+\\',
    // no 'when' — always active
});
```

Repeat for all 12 keybindings.

**Step 3: Commit**

```bash
git add app/src/browser/tiling-commands.ts
git rm app/src/browser/mode-service.ts
git commit -m "refactor(commands): remove ModeService, make tiling keybindings always active"
```

---

## Task 12: Wire `NvimWidgetFactory` inside Pane Descriptors

**Files:**
- Modify: `app/src/browser/panes/neovim-pane.ts`
- Modify: `app/src/browser/panes/terminal-pane.ts`

The `NvimWidgetFactory` symbol needs to be imported correctly. The pane descriptors receive `ctx.diContainer` which is the root InversifyJS container — `NvimWidgetFactory` is bound in it.

Verify the import path resolves:
```ts
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
```

The `ctx.diContainer.get(PtyControlService)` call requires `PtyControlService` to be bound — it is, as a singleton in `mineo-frontend-module.ts`.

The `ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory)` call requires `NvimWidgetFactory` symbol to be bound — it is, via `bindNvimWidgetFactory(bind)`.

No code changes needed if imports resolve correctly. This task is a verification step.

**Step 1: Verify TypeScript compiles**

```bash
cd app && npx tsc --noEmit 2>&1 | head -50
```

Fix any import errors found. Common issues:
- `NvimWidgetFactory` symbol import path
- Missing `PaneRole` cast for string roles in `splitPane()` calls

**Step 2: Commit any fixes**

```bash
git add -p
git commit -m "fix(panes): resolve import paths and type errors"
```

---

## Task 13: Smoke Test

**Step 1: Build and start the app**

```bash
yarn && yarn build 2>&1 | tail -30
yarn start
```

**Step 2: Manual verification checklist**

- [ ] App loads without console errors
- [ ] Default layout shows one neovim pane with header bar visible
- [ ] Header shows: grip `≡`, icon, label "Neovim Editor", split-H button, split-V button, close `×`
- [ ] Click `⊞` → picker appears with Neovim Editor, Terminal, Monaco Editor
- [ ] Select "Terminal" → terminal pane appears to the right, both have headers
- [ ] Click `⊟` → picker appears → select "Neovim Editor" → splits vertically
- [ ] Click `×` on a pane → pane closes, layout collapses correctly
- [ ] Click `×` on last pane in tab → tab closes
- [ ] Drag grip `≡` → drag-and-drop between panes works
- [ ] File navigator (left sidebar) → click a file → opens in focused neovim pane
- [ ] Keybindings work: `Cmd+Shift+\` splits horizontal, `Cmd+Shift+-` splits vertical, `Cmd+Shift+X` closes pane
- [ ] No NEOVIM/MONACO status bar toggle visible
- [ ] Tab operations work: new tab, close tab, next/prev tab

**Step 3: Commit any fixes found during smoke test**

```bash
git add -p
git commit -m "fix(smoke): address issues found during manual testing"
```

---

## Summary of Commits

1. `refactor(types): expand PaneRole, remove widgetId, add version 2`
2. `refactor(layout): migrate v1→v2, default role 'editor'→'neovim'`
3. `feat(panes): add PaneRegistry and PaneDescriptor interface`
4. `feat(panes): add neovim pane descriptor`
5. `feat(panes): add terminal pane descriptor`
6. `feat(panes): add monaco pane descriptor`
7. `feat(styles): add pane header CSS, remove old drag handle styles`
8. `feat(tiling): rewrite TilingContainer with PaneRegistry and pane header`
9. `refactor(tiling-service): remove ModeService, wire PaneRegistry and split requests`
10. `refactor(module): remove ModeService, register PaneRegistry and pane descriptors`
11. `refactor(commands): remove ModeService, make tiling keybindings always active`
12. `fix(panes): resolve import paths and type errors`
13. `fix(smoke): address issues found during manual testing`
