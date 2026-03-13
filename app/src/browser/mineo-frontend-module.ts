import '../../src/browser/style/suppress.css';
import '../../src/browser/style/theme.css';

import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ColorRegistry } from '@theia/core/lib/browser/color-registry';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-constants';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions, ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { EditorManager } from '@theia/editor/lib/browser';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { Widget, waitForRevealed } from '@theia/core/lib/browser/widgets/widget';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';

// Increase disconnected buffer size to 50MB (default is 100KB)
// to prevent "Max disconnected buffer size exceeded" errors when backgrounded
(SocketWriteBuffer as any).DISCONNECTED_BUFFER_SIZE = 50 * 1024 * 1024;

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
  @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;

  private nvimWidget: TerminalWidget | undefined;

  onStart(): void {
    this.modeService.registerActivator(this);
  }

  async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
    // We CANNOT await reachedState('ready') here because this method is called
    // by fireOnDidInitializeLayout(), and 'ready' is only set AFTER that call
    // returns — awaiting here would deadlock.
    //
    // Instead, return immediately and schedule activation once 'ready' fires.
    // The one-shot listener on onStateChanged ensures we run exactly once,
    // after Theia has fully restored the previous session layout.
    const disposable = this.stateService.onStateChanged(state => {
      if (state === 'ready') {
        disposable.dispose();
        this.modeService.activate(this.modeService.currentMode, { startup: true })
          .catch(err => this.messageService.error('Mineo: failed to activate editor mode: ' + err));
      }
    });
  }

  // ── ModeActivator implementation ──────────────────────────────────────────

  async activateNeovimMode(startup: boolean): Promise<void> {
    // Step 0: dirty-check (skipped on startup — no user-created editor state yet)
    // EditorManager has no getDirtyEditors() method in Theia 1.x — use .all + saveable.dirty
    if (!startup) {
      const dirty = this.editorManager.all.filter(w => w.saveable.dirty);
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
      // Wait until the widget is actually visible in the DOM, then trigger
      // an update so xterm.js runs open()+fit() and paints the terminal.
      // Without this, the terminal stays black until the next resize event.
      await waitForRevealed(this.nvimWidget!);
      this.nvimWidget!.update();
    } catch (err) {
      // Rollback: if we just created the widget, dispose it (it may not be in
      // the shell yet, so dispose() is safer than closeWidget())
      if (created && this.nvimWidget) {
        this.nvimWidget.dispose();
        this.nvimWidget = undefined;
      }
      throw err;
    }

    // Step 2: close Monaco editor widgets from the main panel (skipped on startup)
    // We close EditorWidget instances only — not terminal panels, diff viewers, etc.
    // Snapshot into an array first to avoid iterating a live iterator while closing.
    if (!startup) {
      const mainWidgets = Array.from(
        (this.shell.mainPanel as any).widgets() as IterableIterator<Widget>
      ).filter(w => w instanceof EditorWidget);
      await Promise.all(mainWidgets.map(w => this.shell.closeWidget(w.id)));
    }

    // Step 3: poll /api/nvim-ready (non-fatal; never throws)
    await this._waitForNvimReady();
  }

  async activateMonacoMode(): Promise<void> {
    // Close the nvim widget if it exists — hideWidget is not available in Theia 1.69.
    // The widget is recreated on next switch to neovim mode (activateNeovimMode creates
    // a new terminal if nvimWidget is disposed).
    if (this.nvimWidget && !this.nvimWidget.isDisposed) {
      await this.shell.closeWidget(this.nvimWidget.id);
      this.nvimWidget = undefined;
    }
    // Monaco area is already empty — NvimOpenHandler returns -1 in monaco mode
  }

  // ── Private helpers ───────────────────────────────────────────────────────

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

// ─── Terminal Color Theme ───────────────────────────────────────────────────

/**
 * Registers One Dark Pro ANSI terminal colors so xterm.js renders Neovim
 * with the same palette as it appears in a native terminal with this theme.
 * Colors sourced from: https://github.com/Binaryify/OneDark-Pro
 */
@injectable()
class OneDarkTerminalColors implements ColorContribution {
  registerColors(colors: ColorRegistry): void {
    const oneDark: Record<string, string> = {
      'terminal.background':            '#282c34',
      'terminal.foreground':            '#abb2bf',
      'terminalCursor.foreground':      '#528bff',
      'terminalCursor.background':      '#282c34',
      'terminal.selectionBackground':   '#3e4451',
      'terminal.ansiBlack':             '#282c34',
      'terminal.ansiRed':               '#e06c75',
      'terminal.ansiGreen':             '#98c379',
      'terminal.ansiYellow':            '#e5c07b',
      'terminal.ansiBlue':              '#61afef',
      'terminal.ansiMagenta':           '#c678dd',
      'terminal.ansiCyan':              '#56b6c2',
      'terminal.ansiWhite':             '#abb2bf',
      'terminal.ansiBrightBlack':       '#5c6370',
      'terminal.ansiBrightRed':         '#e06c75',
      'terminal.ansiBrightGreen':       '#98c379',
      'terminal.ansiBrightYellow':      '#e5c07b',
      'terminal.ansiBrightBlue':        '#61afef',
      'terminal.ansiBrightMagenta':     '#c678dd',
      'terminal.ansiBrightCyan':        '#56b6c2',
      'terminal.ansiBrightWhite':       '#ffffff',
    };
    for (const [id, value] of Object.entries(oneDark)) {
      colors.register({ id, description: id, defaults: { dark: value, light: value, hcDark: value, hcLight: value } });
    }
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // ModeService — singleton that owns editor mode state
  bind(ModeService).toSelf().inSingletonScope();

  // Register One Dark Pro terminal color palette for xterm.js
  bind(ColorContribution).to(OneDarkTerminalColors).inSingletonScope();

  // Register the Neovim file opener
  bind(OpenHandler).to(NvimOpenHandler).inSingletonScope();

  // Register terminal startup contribution
  bind(FrontendApplicationContribution).to(NvimTerminalContribution).inSingletonScope();

  // Register status bar + toggle command contribution
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
      leftPanelSize: 240, // Keep space for File Explorer
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
