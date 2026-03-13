import '../../src/browser/style/suppress.css';
import '../../src/browser/style/theme.css';

import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-constants';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions, ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { EditorManager } from '@theia/editor/lib/browser';
import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { ServiceConnectionProvider, RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { NvimWidget } from './neovim-widget';
import { LspClientManager } from './lsp-client-manager';
import { TreesitterManager } from './treesitter-manager';

// Increase disconnected buffer size to 50MB (default is 100KB)
// to prevent "Max disconnected buffer size exceeded" errors when backgrounded
(SocketWriteBuffer as any).DISCONNECTED_BUFFER_SIZE = 50 * 1024 * 1024;

// ─── Prevent stale layout restoration ────────────────────────────────────────
// Theia persists the shell layout (including terminal widgets) to localStorage
// on window close, then restores it on reload. This causes stale terminal
// widgets from previous server sessions to race with our nvim widget.
// Nuke the layout key at module-load time (before Theia's DI container starts)
// so Mineo always starts fresh. Our NvimTerminalContribution handles layout.
if (typeof window !== 'undefined' && window.localStorage) {
  const pathname = window.location.pathname;
  window.localStorage.removeItem(`theia:${pathname}:layout`);
}

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
 *   On failure (activator throws), rolls back state and re-throws.
 * - toggle() activates the opposite mode.
 * - registerActivator(activator) must be called before activate() is used
 *   (NvimTerminalContribution calls this in its onStart).
 */
@injectable()
export class ModeService {
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
      // Restore in-memory state; localStorage was NOT written (written above only on success)
      this._currentMode = previous;
      // Re-throw so the caller can toast with context-appropriate messaging
      throw err;
    }
  }

  async toggle(): Promise<void> {
    await this.activate(this._currentMode === 'neovim' ? 'monaco' : 'neovim');
  }
}

/**
 * TouchScrollContribution — adds momentum touch-scroll to all Theia panels.
 * Theia's tree/list widgets use overflow:auto but don't handle touch events.
 * This walks up from the touch target to find the nearest scrollable ancestor
 * and scrolls it, enabling natural touch scrolling in the explorer and sidebars.
 */
@injectable()
class TouchScrollContribution implements FrontendApplicationContribution {
    onStart(): void {
        if (!window.matchMedia('(pointer: coarse)').matches) return;

        let startY = 0;
        let startX = 0;
        let target: Element | null = null;

        const findScrollable = (el: Element | null): Element | null => {
            while (el && el !== document.body) {
                const style = window.getComputedStyle(el);
                const overflowY = style.overflowY;
                const overflowX = style.overflowX;
                const canScrollY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
                const canScrollX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
                if (canScrollY || canScrollX) return el;
                el = el.parentElement;
            }
            return null;
        };

        document.body.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            startY = e.touches[0].clientY;
            startX = e.touches[0].clientX;
            target = findScrollable(e.target as Element);
        }, { passive: true });

        document.body.addEventListener('touchmove', (e: TouchEvent) => {
            if (!target || e.touches.length !== 1) return;
            const dy = startY - e.touches[0].clientY;
            const dx = startX - e.touches[0].clientX;
            target.scrollTop += dy;
            target.scrollLeft += dx;
            startY = e.touches[0].clientY;
            startX = e.touches[0].clientX;
        }, { passive: true });

        document.body.addEventListener('touchend', () => {
            target = null;
        }, { passive: true });
    }
}

/**
 * MenuBarToggleContribution — adds a chevron button that collapses/expands
 * the top menu bar. State is persisted in localStorage.
 */
@injectable()
class MenuBarToggleContribution implements FrontendApplicationContribution {
  @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;

  private static readonly STORAGE_KEY = 'mineo.menuBarCollapsed';
  private _collapsed = false;

  onStart(): void {
    this._collapsed = localStorage.getItem(MenuBarToggleContribution.STORAGE_KEY) === '1';

    // Create the fixed chevron button
    const btn = document.createElement('button');
    btn.className = 'nvim-menu-toggle';
    btn.title = 'Toggle menu bar';
    document.body.appendChild(btn);

    const apply = (isCollapsed: boolean): void => {
      this._collapsed = isCollapsed;
      const panel = document.getElementById('theia-top-panel');
      if (panel) {
        panel.classList.toggle('menu-collapsed', isCollapsed);
      }
      document.body.classList.toggle('nvim-menu-collapsed', isCollapsed);
      btn.textContent = isCollapsed ? '›' : '‹';
      btn.style.display = isCollapsed ? 'block' : '';
      localStorage.setItem(MenuBarToggleContribution.STORAGE_KEY, isCollapsed ? '1' : '0');
    };

    btn.addEventListener('click', () => apply(!this._collapsed));

    // Restore persisted state once the shell has fully rendered
    this.stateService.reachedState('ready').then(() => apply(this._collapsed));
  }
}

// No-op MenuContribution
@injectable()
class NoOpMenuContribution implements MenuContribution {
  registerMenus(_registry: MenuModelRegistry): void {
    // empty
  }
}

// No-op BreadcrumbsContribution
@injectable()
class NoOpBreadcrumbsContribution implements BreadcrumbsContribution {
  readonly type: symbol = Symbol('NoOpBreadcrumbs');
  readonly priority: number = 0;
  private readonly _onDidChangeBreadcrumbs = new Emitter<URI>();
  readonly onDidChangeBreadcrumbs: Event<URI> = this._onDidChangeBreadcrumbs.event;
  async computeBreadcrumbs(_uri: URI): Promise<Breadcrumb[]> { return []; }
  async attachPopupContent(_breadcrumb: Breadcrumb, _parent: HTMLElement): Promise<Disposable | undefined> { return undefined; }
}

/**
 * NvimTerminalContribution manages the Neovim widget lifecycle.
 * It implements ModeActivator so ModeService can trigger widget operations.
 * Uses a dedicated NvimWidget (BaseWidget + xterm.js) instead of Theia's
 * TerminalWidget, completely bypassing TerminalService.
 */
@injectable()
class NvimTerminalContribution implements FrontendApplicationContribution, ModeActivator {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(ModeService) protected readonly modeService!: ModeService;
  @inject(EditorManager) protected readonly editorManager!: EditorManager;
  @inject(MessageService) protected readonly messageService!: MessageService;
  @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;
  @inject(NvimWidget) protected readonly nvimWidget!: NvimWidget;
  @inject(FileNavigatorContribution) protected readonly navigatorContribution!: FileNavigatorContribution;
  @inject(RemoteConnectionProvider) protected readonly connectionProvider!: ServiceConnectionProvider;

  private started = false;
  private bufferWatchActive = false;

  onStart(): void {
    this.modeService.registerActivator(this);

    // Wait for 'ready' state then activate the editor mode.
    // reachedState returns a Deferred that resolves when state >= 'ready'.
    // This is safe here because onStart() runs during 'startContributions'
    // which is before 'ready', so the deferred will resolve later.
    this.stateService.reachedState('ready').then(() => {
      this.modeService.activate(this.modeService.currentMode, { startup: true })
        .catch(err => {
          this.messageService.error('Mineo: failed to activate editor mode: ' + err);
        });
    });
  }

  // ── ModeActivator implementation ──────────────────────────────────────────

  async activateNeovimMode(startup: boolean): Promise<void> {
    // Step 0: dirty-check (skipped on startup — no user-created editor state yet)
    if (!startup) {
      const dirty = this.editorManager.all.filter(w => w.saveable.dirty);
      if (dirty.length > 0) {
        throw new Error('Save or discard Monaco changes before switching to Neovim.');
      }
      // Close Monaco editor widgets from the main panel
      const mainWidgets = Array.from(
        (this.shell.mainPanel as any).widgets() as IterableIterator<Widget>
      ).filter(w => w instanceof EditorWidget);
      await Promise.all(mainWidgets.map(w => this.shell.closeWidget(w.id)));
    }

    // Step 1: start the NvimWidget PTY connection (only once)
    if (!this.started) {
      await this.nvimWidget.start();
      this.started = true;
    }

    // Step 2: add to shell and activate
    this.shell.addWidget(this.nvimWidget, { area: 'main' });
    this.shell.activateWidget(this.nvimWidget.id);

    // Step 3: poll /api/nvim-ready (non-fatal; never throws)
    await this._waitForNvimReady();

    // Step 4: start buffer-watch to sync explorer selection (only once)
    if (!this.bufferWatchActive) {
      this.bufferWatchActive = true;
      this._startBufferWatch();
    }
  }

  async activateMonacoMode(): Promise<void> {
    // Hide the nvim widget (don't dispose — keep the PTY alive)
    if (this.nvimWidget.isAttached) {
      this.shell.closeWidget(this.nvimWidget.id);
    }
    // Monaco area is already empty — NvimOpenHandler returns -1 in monaco mode
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startBufferWatch(): void {
    this.connectionProvider.listen('/services/nvim-buffer-watch', (_path, channel) => {
      channel.onMessage(e => {
        const filePath = e().readString();
        if (!filePath) return;
        const uri = new URI('file://' + filePath);
        // Reveal in file navigator — non-fatal, ignore errors
        this.navigatorContribution.selectFileNode(uri).catch(() => { /* ignore */ });
      });
    }, false);
  }

  private async _waitForNvimReady(): Promise<void> {
    const POLL_MS = 200;
    const MAX_POLLS = 25; // up to ~5 seconds (25 polls × 200ms sleep between attempts)
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
      // Sleep between polls (not after the final one)
      if (i < MAX_POLLS - 1) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    }
    // Timeout — non-fatal toast
    this.messageService.warn(
      'Neovim socket not ready — file opens may not work until nvim initialises.'
    );
  }
}

/**
 * NvimOpenHandler intercepts file-open events from the File Explorer.
 * In neovim mode: forwards to /api/nvim-open with priority 500.
 * In monaco mode: returns -1 (opts out; Theia uses default Monaco handler).
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

/**
 * EditorModeStatusBarContribution shows the current editor mode (NEOVIM / MONACO)
 * in the status bar and registers the `mineo.toggleEditorMode` command.
 */
@injectable()
class EditorModeStatusBarContribution implements FrontendApplicationContribution {
  @inject(ModeService) protected readonly modeService!: ModeService;
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(MessageService) protected readonly messageService!: MessageService;

  private static readonly STATUS_BAR_ID = 'mineo.editorMode';
  private static readonly COMMAND_ID = 'mineo.toggleEditorMode';
  private readonly _toDispose = new DisposableCollection();

  onStart(): void {
    // Register the toggle command — catch async errors so they surface as toasts
    this.commands.registerCommand(
      { id: EditorModeStatusBarContribution.COMMAND_ID, label: 'Mineo: Toggle Editor Mode' },
      { execute: () => this.modeService.toggle().catch(err =>
          this.messageService.error('Mineo: ' + err)) }
    );

    // Set initial status bar entry
    this._updateStatusBar(this.modeService.currentMode);

    // Update on every mode change — store disposable to prevent leak
    this._toDispose.push(
      this.modeService.onModeChange(mode => this._updateStatusBar(mode))
    );
  }

  onStop(): void {
    this._toDispose.dispose();
  }

  private _updateStatusBar(mode: EditorMode): void {
    this.statusBar.setElement(EditorModeStatusBarContribution.STATUS_BAR_ID, {
      text: mode === 'neovim' ? '$(terminal) NEOVIM' : '$(edit) MONACO',
      tooltip: 'Click to toggle editor mode',
      alignment: StatusBarAlignment.LEFT,
      priority: 1000,
      command: EditorModeStatusBarContribution.COMMAND_ID,
    });
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // ModeService — singleton that owns editor mode state
  bind(ModeService).toSelf().inSingletonScope();

  // NvimWidget — singleton BaseWidget with embedded xterm.js (colors baked in)
  bind(NvimWidget).toSelf().inSingletonScope();

  // Register the Neovim file opener
  bind(OpenHandler).to(NvimOpenHandler).inSingletonScope();

  // Register terminal startup contribution
  bind(FrontendApplicationContribution).to(NvimTerminalContribution).inSingletonScope();

  // Register status bar + toggle command contribution
  bind(FrontendApplicationContribution).to(EditorModeStatusBarContribution).inSingletonScope();

  // Touch scroll for Theia panels (explorer, sidebars)
  bind(FrontendApplicationContribution).to(TouchScrollContribution).inSingletonScope();

  // Menu bar collapse/expand toggle
  bind(FrontendApplicationContribution).to(MenuBarToggleContribution).inSingletonScope();

  // LSP client manager — starts Monaco language clients for supported files
  bind(LspClientManager).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).to(LspClientManager).inSingletonScope();

  // Treesitter syntax highlighting — WASM-backed tokenizer for Monaco mode
  bind(TreesitterManager).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).to(TreesitterManager).inSingletonScope();

  // Suppress breadcrumbs
  try {
    rebind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  } catch {
    bind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  }

  // Suppress menu bar
  // bind(MenuContribution).to(NoOpMenuContribution).inSingletonScope();

  // Suppress panels and set initial layout
  try {
    rebind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 240, // Keep space for File Explorer
      rightPanelSize: 0,
      bottomPanelSize: 200, // Space for Theia's built-in terminal
      leftPanelExpandThreshold: 0,
    });
  } catch {
    bind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 240,
      rightPanelSize: 0,
      bottomPanelSize: 200,
      leftPanelExpandThreshold: 0,
    });
  }
});
