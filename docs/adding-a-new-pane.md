# Adding a New Pane Type to Mineo

This guide walks through every file you need to touch, using a **Welcome pane** as a
concrete example. The Welcome pane will display a static HTML greeting with no PTY and no
external dependencies — the simplest possible pane type.

---

## How the system works (30-second overview)

```
PaneRole (string literal)
  └── LeafNode.role          ← stored in the layout tree
  └── PaneDescriptor.role    ← key in PaneRegistry
        └── create()         ← returns a Lumino Widget
        └── destroy()        ← cleanup on close
```

When the user opens a pane the tiling system:
1. Looks up `LeafNode.role` in `PaneRegistry`
2. Calls `PaneDescriptor.create()` to get a widget
3. Mounts that widget inside the pane's content area

You need to touch **four files** to add a new pane type.

---

## File 1 — `app/src/common/layout-types.ts`

Add the new role to the `PaneRole` union. This is the single source of truth for valid
role strings; TypeScript will catch any typo everywhere else.

```typescript
// BEFORE
export type PaneRole = 'neovim' | 'terminal' | 'monaco';

// AFTER
export type PaneRole = 'neovim' | 'terminal' | 'monaco' | 'welcome';
```

---

## File 2 — `app/src/browser/panes/welcome-pane.ts` (new file)

Create the descriptor in its own file inside `app/src/browser/panes/`.

```typescript
/**
 * welcome-pane — a simple static HTML pane with no PTY.
 *
 * Pattern to follow for any UI-only pane:
 *  1. Extend Widget directly (no EditorManager, no PTY).
 *  2. Build your DOM inside this.node in the constructor.
 *  3. Override onActivateRequest to give focus to whatever is focusable.
 *  4. Export a PaneDescriptor object — no class needed in the descriptor.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import type { PaneDescriptor, PaneContext } from './index';

// ── Widget ────────────────────────────────────────────────────────────────────

class WelcomeWidget extends Widget {
    constructor(instanceId: string) {
        super();
        this.id = 'mineo.welcome.' + instanceId;
        this.addClass('mineo-welcome-widget');

        // Build whatever DOM you need directly inside this.node.
        this.node.innerHTML = `
            <div class="mineo-welcome-inner">
                <h1>Welcome to Mineo</h1>
                <p>Press <kbd>Ctrl+Shift+\\</kbd> to split horizontally.</p>
                <p>Press <kbd>Ctrl+Shift+-</kbd> to split vertically.</p>
            </div>
        `;
    }

    // Called when Lumino wants this widget to take keyboard focus.
    protected override onActivateRequest(_msg: Message): void {
        // For a static HTML pane there is nothing interactive to focus.
        // For a pane with a canvas / input, call element.focus() here.
        this.node.focus();
    }
}

// ── Descriptor ────────────────────────────────────────────────────────────────

export const welcomePaneDescriptor: PaneDescriptor = {
    role: 'welcome',           // must match the string you added to PaneRole
    label: 'Welcome',          // shown in the pane-type picker
    icon: 'codicon codicon-home',

    // singleton: true,        // uncomment if only one welcome pane per tab is allowed

    async create(ctx: PaneContext): Promise<Widget> {
        return new WelcomeWidget(ctx.instanceId);
    },

    destroy(widget: Widget, _instanceId: string): void {
        widget.dispose();
    },
};
```

### Notes on the `PaneContext` argument

| Field | Type | Use it when |
|---|---|---|
| `ctx.instanceId` | `string` | You need a stable unique key (widget ID, cache key, etc.) |
| `ctx.role` | `string` | Rarely needed — same as `descriptor.role` |
| `ctx.diContainer` | `interfaces.Container` | You need a Theia service (e.g. `PtyControlService`, `FileService`) |

Accessing a service from the DI container:
```typescript
import { FileService } from '@theia/filesystem/lib/browser/file-service';

async create(ctx: PaneContext): Promise<Widget> {
    const fileService = ctx.diContainer.get(FileService);
    // ...
}
```

---

## File 3 — `app/src/browser/mineo-frontend-module.ts`

Two changes: import the descriptor, then register it.

```typescript
// 1. Add the import next to the other pane imports (around line 29-31)
import { welcomePaneDescriptor } from './panes/welcome-pane';

// 2. Register it inside the FrontendApplicationContribution block (around line 370-376)
bind(FrontendApplicationContribution).toDynamicValue(ctx => {
    const registry = ctx.container.get(PaneRegistry);
    registry.register(neovimPaneDescriptor);
    registry.register(terminalPaneDescriptor);
    registry.register(monacoPaneDescriptor);
    registry.register(welcomePaneDescriptor);   // ← add this line
    return { onStart: () => {} } as any;
}).inSingletonScope();
```

That is all that is **required**. The pane now appears in the split picker UI
(the `⊞` / `⊟` buttons in every pane header) because `PaneRegistry.getAll()` drives
that list automatically.

---

## File 4 (optional) — `app/src/browser/tiling-commands.ts`

Add a dedicated command + keybinding only if you want a keyboard shortcut or a context
menu item that opens this specific pane type directly.

```typescript
// 1. Add the command definition to the TilingCommands namespace
export namespace TilingCommands {
    // ... existing commands ...

    export const PANE_WELCOME: Command = {
        id: 'mineo.pane.welcome',
        label: 'Mineo: Open Welcome Pane',
    };
}

// 2. Register the command in registerCommands()
commands.registerCommand(TilingCommands.PANE_WELCOME, {
    execute: () => this.tilingLayoutService.splitFocusedPane('vertical', 'welcome'),
});

// 3. (Optional) Bind a key in registerKeybindings()
keybindings.registerKeybinding({
    command: TilingCommands.PANE_WELCOME.id,
    keybinding: 'ctrlcmd+shift+w',   // pick a free chord
});
```

---

## Optional — CSS for the new pane

Add styles in `app/src/browser/style/panes.css` (or a new file imported from
`mineo-frontend-module.ts`):

```css
.mineo-welcome-widget {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--theia-foreground);
    background: var(--theia-editor-background);
}

.mineo-welcome-inner {
    text-align: center;
    opacity: 0.75;
}

.mineo-welcome-inner h1 {
    font-size: 1.4rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
}

.mineo-welcome-inner kbd {
    font-family: var(--theia-code-font-family);
    font-size: 0.8em;
    background: var(--theia-keybinding-table-alternateRowBackground);
    border: 1px solid var(--theia-contrastBorder);
    border-radius: 3px;
    padding: 1px 5px;
}
```

---

## Full checklist

| Step | File | What to do |
|---|---|---|
| **1** | `app/src/common/layout-types.ts` | Add `\| 'welcome'` to `PaneRole` |
| **2** | `app/src/browser/panes/welcome-pane.ts` | Create `WelcomeWidget` class + `welcomePaneDescriptor` |
| **3** | `app/src/browser/mineo-frontend-module.ts` | Import descriptor; call `registry.register(welcomePaneDescriptor)` |
| **4** *(opt)* | `app/src/browser/tiling-commands.ts` | Add command + keybinding |
| **5** *(opt)* | `app/src/browser/style/panes.css` | Add CSS |

---

## Patterns for common pane types

### PTY-backed pane (like terminal)

```typescript
async create(ctx: PaneContext): Promise<Widget> {
    const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
    const ptyService = ctx.diContainer.get(PtyControlService);

    const widget = factory({ instanceId: ctx.instanceId, role: ctx.role });
    await ptyService.spawn(ctx.instanceId, ctx.role, 120, 30);
    widget.connectChannels();
    return widget;
},

destroy(widget: Widget, instanceId: string): void {
    const ptyService = /* get from somewhere */ ...;
    ptyService.kill(instanceId).catch(() => {});
    widget.dispose();
},
```

### Monaco-based pane (like monaco-pane.ts)

```typescript
import * as monaco from '@theia/monaco-editor-core';

class MyEditorWidget extends Widget {
    readonly monacoEditor: monaco.editor.IStandaloneCodeEditor;

    constructor(instanceId: string) {
        super();
        this.monacoEditor = monaco.editor.create(this.node, {
            automaticLayout: true,
            theme: 'vs-dark',
        });
    }

    protected override onResize(_msg: Message): void { this.monacoEditor.layout(); }
    protected override onActivateRequest(_msg: Message): void { this.monacoEditor.focus(); }
    override dispose(): void { this.monacoEditor.dispose(); super.dispose(); }
}
```

**Important:** do **not** use `EditorManager.getOrCreateByUri()` — that registers the
widget with Theia's shell and causes it to be pulled out of the pane when a second Monaco
pane is opened. Always create a raw `monaco.editor.create()` instance instead.

### Iframe / webview pane

```typescript
class IframeWidget extends Widget {
    constructor(instanceId: string, src: string) {
        super();
        this.id = 'mineo.iframe.' + instanceId;
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        this.node.appendChild(iframe);
        this.node.style.cssText = 'width:100%;height:100%;';
    }
}
```
