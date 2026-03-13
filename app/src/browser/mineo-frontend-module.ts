import '../../src/browser/style/suppress.css';
import '../../src/browser/style/theme.css';

import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-constants';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions, ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';
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
 * NvimTerminalContribution starts Neovim in a terminal and moves it to the main area
 * automatically on application startup.
 */
@injectable()
class NvimTerminalContribution implements FrontendApplicationContribution {
  @inject(TerminalService) protected readonly terminalService!: TerminalService;
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;

  async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
    // Try to find if Neovim is already running, otherwise spawn it
    let widget = this.terminalService.all.find(t => t.title.label === 'Neovim');
    if (!widget) {
      widget = await this.terminalService.newTerminal({
        title: 'Neovim',
        shellPath: 'nvim'
      });
    }

    if (widget) {
      // Move the terminal widget to the 'main' area where Monaco usually lives
      this.shell.addWidget(widget, { area: 'main' });
      this.shell.activateWidget(widget.id);
    }
  }
}

/**
 * NvimOpenHandler intercepts file-open events from the File Explorer and
 * forwards them to the running Neovim instance via /api/nvim-open.
 */
@injectable()
class NvimOpenHandler implements OpenHandler {
  readonly id = 'mineo.nvim-open';
  readonly label = 'Open in Neovim';

  constructor(
    @inject(MessageService) protected readonly messageService: MessageService
  ) { }

  canHandle(uri: URI): number {
    // Intercept file:// scheme with highest priority
    return uri.scheme === 'file' ? 20000 : 0;
  }

  async open(uri: URI): Promise<object | undefined> {
    const filePath = uri.path.toString();
    try {
      const res = await fetch(`/api/nvim-open?file=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as any).error || `HTTP ${res.status}`;
        this.messageService.warn(`Neovim: ${msg}`);
      }
    } catch (e) {
      this.messageService.error(`Could not reach /api/nvim-open: ${e}`);
    }
    // Return a value to signal to Theia that we've handled the open request
    return { handled: true };
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // ModeService — singleton that owns editor mode state
  bind(ModeService).toSelf().inSingletonScope();

  // Register the Neovim file opener
  bind(OpenHandler).to(NvimOpenHandler).inSingletonScope();

  // Register terminal startup contribution
  bind(FrontendApplicationContribution).to(NvimTerminalContribution).inSingletonScope();

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
