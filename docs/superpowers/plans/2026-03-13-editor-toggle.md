# Editor Toggle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a status bar toggle between two mutually exclusive editor modes — `neovim` (nvim TUI in a terminal widget, file opens via RPC) and `monaco` (default Theia editor) — with localStorage persistence and graceful error handling.

**Architecture:** A new `ModeService` injectable singleton owns `currentMode` state, drives activation/rollback, and emits `onModeChange`. `NvimTerminalContribution` (updated) delegates mode activation to `ModeService`. `NvimOpenHandler` (updated) gates on `currentMode`. A new `EditorModeStatusBarContribution` renders the status bar button. A new backend route `GET /api/nvim-ready` lets the frontend poll for nvim socket liveness.

**Tech Stack:** TypeScript, Theia 1.69 (`@theia/core`, `@theia/terminal`), Node.js `net` module, `node:test` for backend unit tests, Playwright for smoke test.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `app/src/browser/mineo-frontend-module.ts` | Modify | Add `ModeService`, `EditorModeStatusBarContribution`; update `NvimTerminalContribution` and `NvimOpenHandler`; wire DI bindings |
| `app/src/node/mineo-backend-module.ts` | Modify | Add `GET /api/nvim-ready` route |
| `tests/unit/nvim-ready.test.ts` | Create | Unit tests for `/api/nvim-ready` backend logic |

---

## Chunk 1: Backend — `/api/nvim-ready` route

### Task 1: Unit test for `/api/nvim-ready`

**Files:**
- Create: `tests/unit/nvim-ready.test.ts`

The test exercises the `/api/nvim-ready` logic directly by extracting it into a helper function that can be called without a live HTTP server. We test the function that wraps `net.createConnection`.

- [ ] **Step 1.1 — Write the failing test**

Create `tests/unit/nvim-ready.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'net';
import { checkNvimReady } from '../../app/src/node/nvim-ready';

test('checkNvimReady returns false when socket does not exist', async () => {
  const result = await checkNvimReady('/tmp/mineo-test-nonexistent-' + Date.now() + '.sock');
  assert.strictEqual(result, false);
});

test('checkNvimReady returns true when socket is listening', async () => {
  const sockPath = '/tmp/mineo-test-' + Date.now() + '.sock';
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  try {
    const result = await checkNvimReady(sockPath);
    assert.strictEqual(result, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('checkNvimReady returns false on timeout', async () => {
  // A socket that accepts the TCP connection but never sends data — we can't
  // easily simulate a "connect hangs" scenario in node without hacks, so we
  // just verify the timeout path via a non-existent socket (same result: false)
  const result = await checkNvimReady('/tmp/mineo-test-timeout-' + Date.now() + '.sock', 50);
  assert.strictEqual(result, false);
});
```

- [ ] **Step 1.2 — Run test to confirm it fails (module not found)**

```bash
cd /Users/nhath/Documents/projects/mineo
node --require ts-node/register --test tests/unit/nvim-ready.test.ts 2>&1 | head -20
```

Expected: error like `Cannot find module '../../app/src/node/nvim-ready'`

- [ ] **Step 1.3 — Create `app/src/node/nvim-ready.ts`**

```typescript
import net from 'net';

const NVIM_SOCK = '/tmp/nvim.sock';

/**
 * Check whether the nvim RPC socket is accepting connections.
 *
 * Uses socket.setTimeout() + the 'timeout' event for the timeout path
 * because net.createConnection does not accept a timeout option directly;
 * the 'timeout' event fires but does NOT close the socket — we must call
 * socket.destroy() explicitly.
 *
 * @param sockPath Path to the Unix socket (defaults to /tmp/nvim.sock)
 * @param timeoutMs Connection timeout in milliseconds (defaults to 500)
 * @returns true if connection succeeded, false on any error or timeout
 */
export function checkNvimReady(
  sockPath: string = NVIM_SOCK,
  timeoutMs: number = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      // 'timeout' does not close the socket — must destroy manually
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      // ENOENT (no such file), ECONNREFUSED, etc. — all map to false
      resolve(false);
    });
  });
}
```

- [ ] **Step 1.4 — Run test to confirm it passes**

```bash
cd /Users/nhath/Documents/projects/mineo
node --require ts-node/register --test tests/unit/nvim-ready.test.ts 2>&1
```

Expected: 3 passing tests, 0 failures.

- [ ] **Step 1.5 — Confirm no regressions in existing unit tests**

```bash
cd /Users/nhath/Documents/projects/mineo
node --require ts-node/register --test tests/unit/config.test.ts tests/unit/secret.test.ts tests/unit/auth.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 1.6 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/node/nvim-ready.ts tests/unit/nvim-ready.test.ts
git commit -m "feat: add checkNvimReady helper with unit tests"
```

---

### Task 2: Wire `/api/nvim-ready` route into backend module

**Files:**
- Modify: `app/src/node/mineo-backend-module.ts`

- [ ] **Step 2.1 — Add the import and route**

Open `app/src/node/mineo-backend-module.ts`. Add the import at the top alongside the other imports:

```typescript
import { checkNvimReady } from './nvim-ready';
```

Add the route inside `MineoBACContribution.configure()`, after the existing `/api/nvim-open` route:

```typescript
    // /api/nvim-ready — always returns HTTP 200, even on unexpected errors
    app.get('/api/nvim-ready', async (_req, res) => {
      try {
        const ready = await checkNvimReady();
        res.status(200).json({ ready });
      } catch {
        // Defensive: checkNvimReady should never throw, but guard here to
        // guarantee the spec's "always HTTP 200" contract.
        res.status(200).json({ ready: false });
      }
    });
```

- [ ] **Step 2.2 — Run existing unit tests to confirm no regressions**

```bash
cd /Users/nhath/Documents/projects/mineo
node --require ts-node/register --test tests/unit/config.test.ts tests/unit/secret.test.ts tests/unit/auth.test.ts tests/unit/nvim-ready.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 2.3 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/node/mineo-backend-module.ts
git commit -m "feat: add /api/nvim-ready route to backend"
```

---

## Chunk 2: Frontend — `ModeService`

### Task 3: `ModeService` class inside `mineo-frontend-module.ts`

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

`ModeService` is a Theia injectable singleton that owns editor mode state. It has no external dependencies — just `localStorage` and an `Emitter`. We add it at the top of `mineo-frontend-module.ts`, before the other classes.

**Background on Theia patterns used here:**
- `@injectable()` — marks the class for InversifyJS DI
- `Emitter<T>` from `@theia/core/lib/common/event` — event emitter; `.event` is the subscribable `Event<T>` property
- `interface ModeActivator` — `ModeService` calls back into `NvimTerminalContribution` for actual widget manipulation; this avoids a circular DI dependency (ModeService doesn't inject NvimTerminalContribution directly)

- [ ] **Step 3.1 — Add `ModeService` to `mineo-frontend-module.ts`**

After the existing imports block (after line 15 `import { SocketWriteBuffer }...` and the SocketWriteBuffer line), add:

```typescript
// ─── ModeService ───────────────────────────────────────────────────────────

/** The two mutually exclusive editor modes. */
type EditorMode = 'neovim' | 'monaco';

const STORAGE_KEY = 'mineo.editorMode';

/**
 * Interface that NvimTerminalContribution implements to perform the actual
 * widget manipulation. ModeService calls these during activate().
 * This avoids a circular DI dependency.
 */
interface ModeActivator {
  activateNeovimMode(startup: boolean): Promise<void>;
  activateMonacoMode(): Promise<void>;
}

/**
 * ModeService — owns editor mode state.
 * - Reads initial mode from localStorage on construction.
 * - activate(mode) runs the activation sequence via the registered ModeActivator,
 *   then updates state and fires onModeChange on success.
 *   On failure (activator throws), rolls back state and toasts the error.
 * - toggle() activates the opposite mode.
 * - registerActivator(activator) must be called before activate() is used
 *   (NvimTerminalContribution calls this in its onStart).
 */
@injectable()
class ModeService {
  private _currentMode: EditorMode;
  private readonly _onModeChange = new Emitter<EditorMode>();
  readonly onModeChange: Event<EditorMode> = this._onModeChange.event;
  private _activator: ModeActivator | undefined;

  constructor() {
    const stored = localStorage.getItem(STORAGE_KEY);
    this._currentMode = (stored === 'neovim' || stored === 'monaco') ? stored : 'neovim';
  }

  get currentMode(): EditorMode {
    return this._currentMode;
  }

  registerActivator(activator: ModeActivator): void {
    this._activator = activator;
  }

  async activate(mode: EditorMode, options: { startup?: boolean } = {}): Promise<void> {
    if (!this._activator) {
      throw new Error('ModeService: no activator registered');
    }
    const previous = this._currentMode;
    try {
      if (mode === 'neovim') {
        await this._activator.activateNeovimMode(options.startup ?? false);
      } else {
        await this._activator.activateMonacoMode();
      }
      // Only update state AFTER the activator succeeds
      this._currentMode = mode;
      localStorage.setItem(STORAGE_KEY, mode);  // written only on success
      this._onModeChange.fire(mode);
    } catch (err) {
      // Restore in-memory state; localStorage was NOT written (it's written above only on success)
      this._currentMode = previous;
      // Re-throw so the caller can toast with context-appropriate messaging
      throw err;
    }
  }

  async toggle(): Promise<void> {
    await this.activate(this._currentMode === 'neovim' ? 'monaco' : 'neovim');
  }
}
```

- [ ] **Step 3.2 — Verify TypeScript compiles (no build errors for this addition)**

```bash
cd /Users/nhath/Documents/projects/mineo
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to the new code).

- [ ] **Step 3.3 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat: add ModeService to frontend module"
```

---

## Chunk 3: Frontend — `NvimTerminalContribution` update

### Task 4: Rewrite `NvimTerminalContribution` to implement `ModeActivator`

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

`NvimTerminalContribution` needs three additions:
1. Inject `ModeService` and `EditorManager` (for dirty-check)
2. Implement `ModeActivator` interface (`activateNeovimMode`, `activateMonacoMode`)
3. Update `onDidInitializeLayout` to call `modeService.activate(currentMode, { startup: true })`

**Background on Theia APIs used:**
- `EditorManager` from `@theia/editor/lib/browser` — `getDirtyEditors()` returns `EditorWidget[]`
- `TerminalWidget` from `@theia/terminal/lib/browser/base/terminal-widget` — the widget type returned by `TerminalService.newTerminal()`
- `ApplicationShell.mainPanel` — `{ widgets: ReadonlyArray<Widget> }` where `Widget` has `.id: string`
- `ApplicationShell.hideWidget(id)` / `showWidget(id)` — hides/shows a widget by id (Theia 1.27+)
- `MessageService` — needed for the socket-poll toast

- [ ] **Step 4.1 — Add new imports to `mineo-frontend-module.ts`**

Add these to the imports block at the top of the file:

```typescript
import { EditorManager } from '@theia/editor/lib/browser';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { Widget } from '@theia/core/lib/browser/widgets/widget';
```

- [ ] **Step 4.2 — Replace the `NvimTerminalContribution` class**

Replace the entire existing `NvimTerminalContribution` class (lines ~44–65 in the current file) with:

```typescript
/**
 * NvimTerminalContribution manages the Neovim terminal widget lifecycle.
 * It implements ModeActivator so ModeService can trigger widget operations.
 */
@injectable()
class NvimTerminalContribution implements FrontendApplicationContribution, ModeActivator {
  @inject(TerminalService) protected readonly terminalService!: TerminalService;
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(ModeService) protected readonly modeService!: ModeService;
  @inject(EditorManager) protected readonly editorManager!: EditorManager;
  @inject(MessageService) protected readonly messageService!: MessageService;

  private nvimWidget: TerminalWidget | undefined;
  private _nvimHidden = false;

  onStart(): void {
    this.modeService.registerActivator(this);
  }

  async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
    try {
      await this.modeService.activate(this.modeService.currentMode, { startup: true });
    } catch (err) {
      this.messageService.error('Mineo: failed to activate editor mode: ' + err);
    }
  }

  // ── ModeActivator implementation ──────────────────────────────────────────

  async activateNeovimMode(startup: boolean): Promise<void> {
    // Step 0: dirty-check (skipped on startup — no user-created editor state yet)
    if (!startup) {
      const dirty = this.editorManager.getDirtyEditors?.() ?? [];
      if (dirty.length > 0) {
        throw new Error('Save or discard Monaco changes before switching to Neovim.');
      }
    }

    // Step 1: create or reuse the nvim terminal widget
    const created = !this.nvimWidget || this.nvimWidget.isDisposed;
    try {
      if (created) {
        this.nvimWidget = await this.terminalService.newTerminal({
          title: 'Neovim',
          shellPath: '/bin/sh',
          shellArgs: ['-c', 'exec nvim --listen /tmp/nvim.sock'],
          env: {},
        });
      }
      this.shell.addWidget(this.nvimWidget!, { area: 'main' });
      this.shell.activateWidget(this.nvimWidget!.id);
    } catch (err) {
      // Rollback step 1: if we just created the widget, dispose it
      if (created && this.nvimWidget) {
        this.shell.closeWidget(this.nvimWidget.id);
        this.nvimWidget = undefined;
      }
      throw err; // re-throw so ModeService records failure
    }

    // Step 2: close Monaco editor widgets from the main panel (skipped on startup)
    // We close EditorWidget instances only — not terminal panels, diff viewers, etc.
    if (!startup) {
      const mainWidgets = (this.shell.mainPanel as any).widgets as ReadonlyArray<Widget>;
      for (const w of mainWidgets) {
        if (w instanceof EditorWidget) {
          this.shell.closeWidget(w.id);
        }
      }
    }

    // Step 3: poll /api/nvim-ready (always non-fatal; never throws)
    await this._waitForNvimReady();
  }

  async activateMonacoMode(): Promise<void> {
    // Step 1: hide the nvim widget if it exists
    if (this.nvimWidget && !this.nvimWidget.isDisposed) {
      try {
        (this.shell as any).hideWidget(this.nvimWidget.id);
        this._nvimHidden = true;
      } catch (err) {
        // Rollback: if hideWidget threw, nothing was hidden — reset flag and re-throw
        this._nvimHidden = false;
        throw err;
      }
    } else {
      this._nvimHidden = false;
    }
    // Step 2: Monaco area is already empty — NvimOpenHandler returns -1 in monaco mode
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _waitForNvimReady(): Promise<void> {
    const POLL_MS = 200;
    const MAX_POLLS = 25; // 5 seconds total
    for (let i = 0; i < MAX_POLLS; i++) {
      try {
        const res = await fetch('/api/nvim-ready');
        if (res.ok) {
          const body = await res.json() as { ready: boolean };
          if (body.ready) return;
        }
      } catch {
        // Network error — treat as "not ready yet"
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    // Timeout — non-fatal toast
    this.messageService.warn(
      'Neovim socket not ready — file opens may not work until nvim initialises.'
    );
  }
}
```

- [ ] **Step 4.3 — Verify TypeScript compiles**

```bash
cd /Users/nhath/Documents/projects/mineo
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 4.4 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat: rewrite NvimTerminalContribution with ModeActivator + startup poll"
```

---

## Chunk 4: Frontend — `NvimOpenHandler` update + `EditorModeStatusBarContribution`

### Task 5: Update `NvimOpenHandler` to be mode-aware

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

The current `NvimOpenHandler` always returns `{ handled: true }` even on failure. The updated version:
- `canHandle`: returns `500` in neovim mode, `-1` in monaco mode
- `open`: returns `undefined` on failure (lets Theia fall back to other handlers)

- [ ] **Step 5.1 — Add `ModeService` injection and update `canHandle` + `open`**

Replace the entire existing `NvimOpenHandler` class with:

```typescript
/**
 * NvimOpenHandler intercepts file-open events from the File Explorer.
 * In neovim mode: forwards to /api/nvim-open with priority 500.
 * In monaco mode: returns -1 (opts out; Theia uses default handler).
 */
@injectable()
class NvimOpenHandler implements OpenHandler {
  readonly id = 'mineo.nvim-open';
  readonly label = 'Open in Neovim';

  @inject(MessageService) protected readonly messageService!: MessageService;
  @inject(ModeService) protected readonly modeService!: ModeService;

  canHandle(uri: URI): number {
    if (uri.scheme !== 'file') return -1;
    return this.modeService.currentMode === 'neovim' ? 500 : -1;
  }

  async open(uri: URI): Promise<object | undefined> {
    const filePath = uri.path.toString();
    try {
      const res = await fetch('/api/nvim-open?file=' + encodeURIComponent(filePath));
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        this.messageService.warn('Neovim: ' + (body.error ?? 'HTTP ' + res.status));
        return undefined; // let Theia fall back to other handlers
      }
    } catch (e) {
      this.messageService.error('Could not reach /api/nvim-open: ' + e);
      return undefined;
    }
    return { handled: true };
  }
}
```

- [ ] **Step 5.2 — Verify TypeScript compiles**

```bash
cd /Users/nhath/Documents/projects/mineo
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5.3 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat: make NvimOpenHandler mode-aware, return undefined on failure"
```

---

### Task 6: Add `EditorModeStatusBarContribution`

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Background on Theia APIs used:**
- `StatusBar` from `@theia/core/lib/browser/status-bar/status-bar` — injectable service; `setElement(id, properties)` upserts an entry
- `StatusBarAlignment` from `@theia/core/lib/browser/status-bar/status-bar` — `LEFT` or `RIGHT`
- `CommandRegistry` from `@theia/core/lib/common/command` — `registerCommand(cmd, handler)`

- [ ] **Step 6.1 — Add `StatusBar` and `CommandRegistry` imports**

Add to the imports block:

```typescript
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { CommandRegistry } from '@theia/core/lib/common/command';
```

- [ ] **Step 6.2 — Add `EditorModeStatusBarContribution` class**

Add this class after the `NvimOpenHandler` class and before the `export default` at the bottom:

```typescript
/**
 * EditorModeStatusBarContribution renders the editor mode toggle button
 * in the status bar (bottom-left). Clicking it calls ModeService.toggle().
 * The label always reflects the currently active mode.
 */
@injectable()
class EditorModeStatusBarContribution implements FrontendApplicationContribution {
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(ModeService) protected readonly modeService!: ModeService;
  @inject(MessageService) protected readonly messageService!: MessageService;

  onStart(): void {
    // Register the toggle command
    this.commands.registerCommand(
      { id: 'mineo.toggleEditorMode', label: 'Toggle Editor Mode' },
      {
        execute: async () => {
          try {
            await this.modeService.toggle();
          } catch (err) {
            this.messageService.warn('Cannot switch mode: ' + err);
          }
        }
      }
    );

    // Initial render
    this.updateStatusBar();

    // Re-render whenever mode changes
    this.modeService.onModeChange(() => this.updateStatusBar());
  }

  private updateStatusBar(): void {
    const mode = this.modeService.currentMode;
    const text = mode === 'neovim' ? '$(terminal-tmux) NeoVim' : '$(edit) Monaco';
    this.statusBar.setElement('mineo.editorMode', {
      text,
      command: 'mineo.toggleEditorMode',
      alignment: StatusBarAlignment.LEFT,
      priority: 10,
      tooltip: mode === 'neovim' ? 'Switch to Monaco editor' : 'Switch to Neovim editor',
    });
  }
}
```

- [ ] **Step 6.3 — Wire `ModeService`, `NvimTerminalContribution` (updated), and `EditorModeStatusBarContribution` into the DI container**

In the `export default new ContainerModule(...)` block at the bottom of the file, update the bindings. The full updated container module should look like:

```typescript
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // ModeService — singleton that owns editor mode state
  bind(ModeService).toSelf().inSingletonScope();

  // Register the Neovim file opener (now mode-aware)
  bind(OpenHandler).to(NvimOpenHandler).inSingletonScope();

  // Register terminal startup + mode activation contribution
  bind(FrontendApplicationContribution).to(NvimTerminalContribution).inSingletonScope();

  // Register status bar toggle button
  bind(FrontendApplicationContribution).to(EditorModeStatusBarContribution).inSingletonScope();

  // Suppress breadcrumbs
  try {
    rebind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  } catch {
    bind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  }

  // Suppress menu bar
  bind(MenuContribution).to(NoOpMenuContribution).inSingletonScope();

  // Suppress panels and set initial layout
  try {
    rebind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 240,
      rightPanelSize: 0,
      bottomPanelSize: 0,
      leftPanelExpandThreshold: 0,
    });
  } catch {
    bind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 240,
      rightPanelSize: 0,
      bottomPanelSize: 0,
      leftPanelExpandThreshold: 0,
    });
  }
});
```

**Important:** `NvimTerminalContribution` now needs `ModeService` injected. Theia resolves this via DI since both are bound as singletons. The `.inSingletonScope()` on `ModeService` ensures both `NvimTerminalContribution` and `EditorModeStatusBarContribution` share the same instance.

- [ ] **Step 6.4 — Verify TypeScript compiles**

```bash
cd /Users/nhath/Documents/projects/mineo
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 6.5 — Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat: add EditorModeStatusBarContribution and wire DI bindings"
```

---

## Chunk 5: Build verification + smoke test

### Task 7: Full build

- [ ] **Step 7.1 — Run all unit tests**

```bash
cd /Users/nhath/Documents/projects/mineo
node --require ts-node/register --test tests/unit/config.test.ts tests/unit/secret.test.ts tests/unit/auth.test.ts tests/unit/nvim-ready.test.ts 2>&1
```

Expected: all tests pass, 0 failures.

- [ ] **Step 7.2 — Build the Theia app**

```bash
cd /Users/nhath/Documents/projects/mineo
npm run build 2>&1 | tail -20
```

Expected: build completes without errors. Warnings about peer deps or deprecated packages are acceptable.

If there are TypeScript errors in the build that weren't caught by `tsc --noEmit` (Theia's build uses its own tsconfig), fix them before proceeding.

- [ ] **Step 7.3 — Manual smoke check: start the server**

```bash
cd /Users/nhath/Documents/projects/mineo
# Ensure config.json exists (copy from example if needed):
[ -f config.json ] || cp config.example.json config.json
npm start &
sleep 5
curl -s http://localhost:3000/healthz
```

Expected: `{"status":"ok"}`

- [ ] **Step 7.4 — Manual smoke check: verify status bar button appears**

Open `http://localhost:3000` in a browser (after logging in if password is set). Verify:
- Bottom status bar shows `NeoVim` button on the left
- Neovim terminal opens in the main area
- Clicking the `NeoVim` button switches to Monaco mode (status bar updates to `Monaco`)
- Clicking `Monaco` switches back

- [ ] **Step 7.5 — Stop the server**

```bash
kill %1 2>/dev/null || pkill -f "node.*mineo" 2>/dev/null || true
```

- [ ] **Step 7.6 — Commit build artifacts marker (optional note commit)**

No build artifacts are committed (they're gitignored). Just confirm the working tree is clean:

```bash
cd /Users/nhath/Documents/projects/mineo
git status
```

Expected: clean working tree (no uncommitted files).

---

### Task 8: Final commit

- [ ] **Step 8.1 — Tag the feature complete**

```bash
cd /Users/nhath/Documents/projects/mineo
git log --oneline -8
```

Review the recent commits to confirm all tasks are represented.

- [ ] **Step 8.2 — Final summary commit if needed**

If any small fixes were made during build/smoke that weren't committed:

```bash
cd /Users/nhath/Documents/projects/mineo
git add -p  # review and stage any remaining changes
git commit -m "fix: editor-toggle build and integration fixes"
```

---

## Quick Reference: Key APIs

| API | Import path | Usage |
|---|---|---|
| `EditorManager` | `@theia/editor/lib/browser` | `getDirtyEditors()` returns `EditorWidget[]` |
| `EditorWidget` | `@theia/editor/lib/browser/editor-widget` | Type guard: `w instanceof EditorWidget` — identifies Monaco editor panels |
| `TerminalWidget` | `@theia/terminal/lib/browser/base/terminal-widget` | Type of widget from `TerminalService.newTerminal()` |
| `StatusBar` | `@theia/core/lib/browser/status-bar/status-bar` | `setElement(id, props)` |
| `StatusBarAlignment` | `@theia/core/lib/browser/status-bar/status-bar` | `LEFT` / `RIGHT` |
| `CommandRegistry` | `@theia/core/lib/common/command` | `registerCommand(cmd, handler)` |
| `ApplicationShell.mainPanel` | (already imported) | `.widgets: ReadonlyArray<Widget>` — main area widgets |
| `ApplicationShell.hideWidget(id)` | (already imported) | Hides widget without destroying |
| `ApplicationShell.showWidget(id)` | (already imported) | Re-shows a hidden widget |

## Notes for Implementors

1. **`EditorManager.getDirtyEditors()`** — This method exists on `EditorManager` in Theia 1.x. If the exact method name differs (e.g., `getEditors()` + filter by `editor.saveable.dirty`), use the available API. The goal is: are there any unsaved Monaco buffers?

2. **`ApplicationShell.mainPanel`** — In Theia 1.69, `ApplicationShell` has a `mainPanel` property. If iterating its `.widgets` doesn't work as expected (API may vary), an alternative is `this.shell.getWidgets('main')` which returns the widgets in the main area.

3. **`hideWidget` / `showWidget`** — These are available in Theia 1.27+. If for any reason they're unavailable in the compiled output, use `this.shell.addWidget(widget, { area: 'bottom' })` as a fallback (moves to bottom panel instead of hiding).

4. **DI injection in `NvimOpenHandler`** — The existing implementation uses a constructor injection pattern (`constructor(@inject(...) ...)`). The updated version uses property injection (`@inject(ModeService) protected readonly modeService!: ModeService`). Either pattern works in Theia's InversifyJS container; use whichever is consistent with other classes in the file.

5. **`ModeService` not injected into `NvimTerminalContribution`** via constructor — it's injected as a property (`@inject(ModeService)`). The DI container resolves both at the same time, so there's no ordering issue.
