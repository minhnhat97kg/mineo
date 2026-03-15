# Simplify Browser Source — Three Refactors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce cognitive load in the browser source by removing ~150 lines of the most tangled code across three independent, safe refactors.

**Architecture:**
- **Refactor A** — Replace incremental Lumino widget-tree surgery (`handleSplit` / `handleClose`) with reactive full rebuilds driven by `rebuildLayout()`, which already exists and uses the widget pool to prevent flicker.
- **Refactor B** — Make `LayoutTreeManager.setFocusedLeaf` the single owner of focus state; `TilingContainer` reacts to `onFocusChange` rather than being called imperatively from six places.
- **Refactor C** — Merge the identical `neovim-pane.ts` and `terminal-pane.ts` into a single `makePtyPane` factory, deleting one file.

**Tech Stack:** TypeScript, Lumino widgets, InversifyJS, Theia shell

---

## Refactor A: Reactive layout rebuilds

Remove `handleSplit()` and `handleClose()` from `TilingContainer`. On layout change, containers call `rebuildLayout()` instead of doing surgical Lumino tree edits. The static `widgetPool` already prevents black screens.

### Task A1: Wire containers to rebuild on layout change

**Files:**
- Modify: `app/src/browser/tiling-layout-service.ts`
- Modify: `app/src/browser/tiling-container.ts`

This task only adds the reactive wiring — it does not yet delete the old methods (that is Task A3). After this task, both paths exist; they'll be tested in A2 before A3 removes the old path.

**Step 1: In `TilingContainer`, subscribe to `onLayoutChange` in the constructor**

The constructor currently is:
```typescript
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
```

Add a layout-change subscription at the end of the constructor:

```typescript
// Rebuild when the layout model changes for this tab
this.toDispose.push(
    this.layoutTreeManager.onLayoutChange(() => {
        const freshTab = this.layoutTreeManager.layout.tabs.find(t => t.id === this.tabLayout.id);
        if (!freshTab) return; // tab was removed — TilingLayoutService handles shell cleanup
        this.tabLayout = freshTab;
        this.rebuildLayout();
    })
);
```

**Step 2: In `TilingLayoutService.splitFocusedPane()`, remove the `handleSplit` call**

Current code (lines ~220–237):
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, direction, role);
if (!newLeaf) return;

const tab = this.layoutTreeManager.layout.tabs.find(t => t.id === tabId);
if (!tab) return;

const splitNode = this.findSplitContaining(tab.root, newLeaf.id);
if (!splitNode) return;

await container.handleSplit(leafId, newLeaf, splitNode.id, direction, splitNode.sizes);

requestAnimationFrame(() => {
    container.focusLeaf(newLeaf.id);
});
```

Replace with:
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, direction, role);
if (!newLeaf) return;

// rebuildLayout is triggered by onLayoutChange subscription in TilingContainer.
// We just need to focus the new leaf after the rebuild settles.
requestAnimationFrame(() => {
    container.focusLeaf(newLeaf.id);
});
```

**Step 3: In `TilingLayoutService.splitPaneByLeafId()`, do the same**

Current (lines ~367–382):
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, direction, role as any);
if (!newLeaf) return;

const tab = this.layoutTreeManager.layout.tabs.find(t => t.id === tabId);
if (!tab) return;

const splitNode = this.findSplitContaining(tab.root, newLeaf.id);
if (!splitNode) return;

await container.handleSplit(leafId, newLeaf, splitNode.id, direction, splitNode.sizes);
requestAnimationFrame(() => container.focusLeaf(newLeaf.id));
```

Replace with:
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, direction, role as any);
if (!newLeaf) return;
requestAnimationFrame(() => container.focusLeaf(newLeaf.id));
```

**Step 4: In `TilingLayoutService.openFileInNewPane()`, do the same**

Current (lines ~325–338):
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, 'horizontal', 'neovim');
if (!newLeaf) return;

const tab = this.layoutTreeManager.layout.tabs.find(t => t.id === tabId);
if (!tab) return;

const splitNode = this.findSplitContaining(tab.root, newLeaf.id);
if (!splitNode) return;

await container.handleSplit(leafId, newLeaf, splitNode.id, splitNode.direction, splitNode.sizes);

requestAnimationFrame(() => {
    container.focusLeaf(newLeaf.id);
});
```

Replace with:
```typescript
const newLeaf = this.layoutTreeManager.splitPane(tabId, leafId, 'horizontal', 'neovim');
if (!newLeaf) return;
requestAnimationFrame(() => {
    container.focusLeaf(newLeaf.id);
});
```

**Step 5: In `TilingLayoutService.closePaneById()`, remove the `handleClose` call**

Current (lines ~266–287):
```typescript
} else {
    await container.handleClose(leafId);
    const leaves = this.layoutTreeManager.getTabLeaves(tabId);
    if (leaves.length > 0) {
        container.focusLeaf(leaves[0].id);
    }
}
```

Replace with:
```typescript
} else {
    // rebuildLayout triggered by onLayoutChange; focus first remaining leaf after settle
    requestAnimationFrame(() => {
        const leaves = this.layoutTreeManager.getTabLeaves(tabId);
        if (leaves.length > 0) container.focusLeaf(leaves[0].id);
    });
}
```

**Step 6: Remove the `syncContainersWithModel()` debounce in `TilingLayoutService.init()`**

The current `init()` has a debounced sync to handle container add/remove. Container rebuilds are now handled by the per-container subscription added in Step 1. The `syncContainersWithModel()` method is still needed for **tab-level** add/remove (adding/removing shell widgets), but the split/close mutations no longer need it.

No change needed here — `syncContainersWithModel()` is fine to keep for tab lifecycle. It only creates/removes shell widgets; individual container rebuilds are handled by the subscription.

**Step 7: Manually test split and close**

Build and run the app. Verify:
- Split horizontal works (new pane appears, gets focus)
- Split vertical works
- Close pane works (remaining pane stays visible, gets focus)
- Close last pane in tab closes the tab
- Drag-drop still works (it calls `rebuildLayout()` directly — no change needed)

**Step 8: Commit**

```bash
git add app/src/browser/tiling-container.ts app/src/browser/tiling-layout-service.ts
git commit -m "refactor: wire TilingContainer to rebuild on layout change events"
```

---

### Task A2: Delete `handleSplit` and `handleClose` from TilingContainer

**Files:**
- Modify: `app/src/browser/tiling-container.ts`

Only do this after Task A1 is confirmed working.

**Step 1: Delete `handleSplit` method**

Remove the entire `handleSplit` method (lines ~398–444 in the current file):
```typescript
async handleSplit(
    leafId: string,
    newLeaf: LeafNode,
    splitId: string,
    direction: 'horizontal' | 'vertical',
    sizes: number[],
): Promise<void> {
    // ... ~45 lines of Lumino parent/grandparent traversal ...
}
```

**Step 2: Delete `handleClose` method**

Remove the entire `handleClose` method (lines ~446–499):
```typescript
async handleClose(leafId: string): Promise<void> {
    // ... ~55 lines ...
}
```

**Step 3: Delete `findSplitContaining` from TilingLayoutService**

The private method `findSplitContaining` (lines ~349–358 in tiling-layout-service.ts) was only used to get the split ID/sizes for `handleSplit`. Delete it:
```typescript
private findSplitContaining(node: any, childId: string): any {
    // ...
}
```

**Step 4: Build and verify no TypeScript errors**

```bash
cd app && yarn build 2>&1 | grep -E "error TS"
```

Expected: no errors.

**Step 5: Manually test**

Same checks as Task A1 Step 7.

**Step 6: Commit**

```bash
git add app/src/browser/tiling-container.ts app/src/browser/tiling-layout-service.ts
git commit -m "refactor: delete handleSplit/handleClose — layout changes trigger rebuildLayout"
```

---

## Refactor B: Single-owner focus state

Remove the dual-call pattern where both `TilingContainer.setActivePane()` (CSS classes) and `LayoutTreeManager.setFocusedLeaf()` (model) are called imperatively from 6 places. Make `setActivePane` react to `onFocusChange` instead.

### Task B1: Make TilingContainer react to focus changes

**Files:**
- Modify: `app/src/browser/tiling-container.ts`

**Step 1: Subscribe to `onFocusChange` in the constructor**

After the `onLayoutChange` subscription added in A1, add:

```typescript
// Sync active-pane CSS whenever the model's focus changes
this.toDispose.push(
    this.layoutTreeManager.onFocusChange(leafId => {
        for (const [id, wrapper] of this.wrapperMap) {
            wrapper.node.classList.toggle('mineo-pane-active', id === leafId);
        }
    })
);
```

**Step 2: Remove the CSS-update half of `setActivePane`**

Current `setActivePane`:
```typescript
private setActivePane(leafId: string): void {
    for (const [id, wrapper] of this.wrapperMap) {
        wrapper.node.classList.toggle('mineo-pane-active', id === leafId);
    }
    this.layoutTreeManager.setFocusedLeaf(leafId);
}
```

Simplify to just the model call — the CSS is now handled by the subscription:
```typescript
private setActivePane(leafId: string): void {
    this.layoutTreeManager.setFocusedLeaf(leafId);
}
```

**Step 3: Build and test**

```bash
cd app && yarn build 2>&1 | grep -E "error TS"
```

Click between panes — verify the active pane gets the `mineo-pane-active` CSS class, and focus highlight updates correctly.

**Step 4: Commit**

```bash
git add app/src/browser/tiling-container.ts
git commit -m "refactor: TilingContainer reacts to onFocusChange instead of dual-setting CSS"
```

---

## Refactor C: Merge neovim-pane and terminal-pane

### Task C1: Create `makePtyPane` factory and update neovim-pane.ts

**Files:**
- Modify: `app/src/browser/panes/neovim-pane.ts`
- Delete: `app/src/browser/panes/terminal-pane.ts`

**Step 1: Rewrite `neovim-pane.ts` to export a factory + both descriptors**

Replace the entire file content with:

```typescript
/**
 * PTY-backed pane descriptors — Neovim editor and terminal shell.
 * Both use NvimWidget; they differ only in role, label, icon, and PTY type.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { NvimWidget } from '../neovim-widget';
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
import type { PaneDescriptor, PaneContext } from './index';
import type { PaneRole } from '../../common/layout-types';

function makePtyPane(config: {
    role: PaneRole;
    label: string;
    icon: string;
    ptyType: string;
}): PaneDescriptor {
    return {
        role: config.role,
        label: config.label,
        icon: config.icon,

        async create(ctx: PaneContext): Promise<Widget> {
            const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
            const ptyService = ctx.diContainer.get(PtyControlService);

            const widget = factory({ instanceId: ctx.instanceId, role: config.role });

            const hash = window.location.hash.replace(/^#/, '');
            const cwd = hash.startsWith('/') ? hash : undefined;
            await ptyService.spawn(ctx.instanceId, config.ptyType, 120, 30, cwd);
            widget.connectChannels();

            return widget;
        },

        destroy(widget: Widget, _instanceId: string): void {
            if (widget instanceof NvimWidget) {
                widget.dispose();
            }
        },
    };
}

export const neovimPaneDescriptor: PaneDescriptor = makePtyPane({
    role: 'neovim',
    label: 'Neovim Editor',
    icon: 'codicon codicon-terminal',
    ptyType: 'neovim',
});

export const terminalPaneDescriptor: PaneDescriptor = makePtyPane({
    role: 'terminal',
    label: 'Terminal',
    icon: 'codicon codicon-terminal-bash',
    ptyType: 'terminal',
});
```

**Step 2: Delete `terminal-pane.ts`**

```bash
rm app/src/browser/panes/terminal-pane.ts
```

**Step 3: Update any imports of `terminal-pane`**

Search for imports:
```bash
grep -r "terminal-pane" app/src/
```

The only place that imports `terminalPaneDescriptor` is `mineo-frontend-module.ts`. Update that import to point to `neovim-pane`:

Find the line:
```typescript
import { terminalPaneDescriptor } from './panes/terminal-pane';
```

Replace with:
```typescript
import { terminalPaneDescriptor } from './panes/neovim-pane';
```

**Step 4: Build and verify**

```bash
cd app && yarn build 2>&1 | grep -E "error TS"
```

Expected: no errors.

**Step 5: Test terminal pane**

In the app: split a pane and open a Terminal pane. Verify it spawns a shell, input/output works, and the pane header shows the correct icon and label.

**Step 6: Commit**

```bash
git add app/src/browser/panes/neovim-pane.ts app/src/browser/mineo-frontend-module.ts
git rm app/src/browser/panes/terminal-pane.ts
git commit -m "refactor: merge neovim-pane and terminal-pane into makePtyPane factory"
```

---

## Summary

| Refactor | Lines removed | Risk |
|----------|--------------|------|
| A: Reactive rebuilds (delete handleSplit/handleClose + findSplitContaining) | ~115 | Low — rebuildLayout already proven by drag-drop |
| B: Single-owner focus | ~8 (code dedup) | Very low — pure event wiring |
| C: Merge PTY panes | ~36 (delete terminal-pane.ts) | None |

Execute A → B → C in order (A depends on rebuildLayout being solid before B adds event wiring on top of it).
