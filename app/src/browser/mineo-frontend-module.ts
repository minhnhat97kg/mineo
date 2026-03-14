import '../../src/browser/style/suppress.css';
import '../../src/browser/style/theme.css';
import '../../src/browser/style/tiling.css';
import '../../src/browser/style/settings.css';
import '../../src/browser/style/panes.css';

import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-constants';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions } from '@theia/core/lib/browser/shell/application-shell';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { KeybindingContribution } from '@theia/core/lib/browser/keybinding';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { ServiceConnectionProvider, RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { SelectionService } from '@theia/core/lib/common/selection-service';
import { UriSelection } from '@theia/core/lib/common/selection';
import { FileNavigatorContribution, NavigatorContextMenu } from '@theia/navigator/lib/browser/navigator-contribution';
import { MonarchTokenizer } from './monarch-tokenizer';
import { PaneRegistry } from './panes/index';
import { neovimPaneDescriptor } from './panes/neovim-pane';
import { terminalPaneDescriptor } from './panes/terminal-pane';
import { monacoPaneDescriptor } from './panes/monaco-pane';
import { LspClientManager } from './lsp-client-manager';
import { TilingLayoutService } from './tiling-layout-service';
import { LayoutTreeManager } from './layout-tree-manager';
import { PtyControlService } from './pty-control-service';
import { bindNvimWidgetFactory } from './nvim-widget-factory';
import { TilingCommandContribution } from './tiling-commands';
import { SettingsContribution } from './settings-widget';
import { NvimPreferenceContribution, NvimPreferenceSyncContribution } from './nvim-preferences';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';

// Increase disconnected buffer size to 50MB (default is 100KB)
// to prevent "Max disconnected buffer size exceeded" errors when backgrounded
(SocketWriteBuffer as any).DISCONNECTED_BUFFER_SIZE = 50 * 1024 * 1024;

// ── Language associations ─────────────────────────────────────────────────────
// @theia/monaco-editor-core is a stripped-down build with no built-in language
// definitions. The typescript-language-features VSCode plugin also doesn't
// contribute a "languages" manifest key. Without these registrations, all files
// open as Plain Text, which breaks both TreeSitter tokenization and LSP dispatch
// (both key on languageId). Register the mappings here at module-load time so
// Monaco's ILanguageService.createByFilepathOrFirstLine() resolves them before
// any editor widget is created.
import * as monaco from '@theia/monaco-editor-core';
const LANG_ASSOCIATIONS: Array<{ id: string; extensions: string[]; aliases: string[] }> = [
  { id: 'typescript',  extensions: ['.ts', '.tsx'],          aliases: ['TypeScript', 'ts']   },
  { id: 'javascript',  extensions: ['.js', '.jsx', '.mjs'],  aliases: ['JavaScript', 'js']   },
  { id: 'python',      extensions: ['.py', '.pyw'],          aliases: ['Python', 'py']       },
  { id: 'go',          extensions: ['.go'],                  aliases: ['Go']                 },
  { id: 'rust',        extensions: ['.rs'],                  aliases: ['Rust', 'rs']         },
  { id: 'json',        extensions: ['.json'],                aliases: ['JSON', 'json']       },
  { id: 'markdown',    extensions: ['.md', '.markdown'],     aliases: ['Markdown', 'md']     },
  { id: 'html',        extensions: ['.html', '.htm'],        aliases: ['HTML', 'html']       },
  { id: 'css',         extensions: ['.css'],                 aliases: ['CSS', 'css']         },
  { id: 'shellscript', extensions: ['.sh', '.bash'],         aliases: ['Shell Script', 'sh'] },
  { id: 'yaml',        extensions: ['.yml', '.yaml'],        aliases: ['YAML', 'yaml']       },
];
for (const lang of LANG_ASSOCIATIONS) {
  monaco.languages.register(lang);
}

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
 * NvimTerminalContribution manages the tiling layout lifecycle.
 * Uses TilingLayoutService to manage NvimWidgets (via factory) as
 * standalone Theia tabs.
 */
@injectable()
class NvimTerminalContribution implements FrontendApplicationContribution {
  @inject(MessageService) protected readonly messageService!: MessageService;
  @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;
  @inject(TilingLayoutService) protected readonly tilingLayoutService!: TilingLayoutService;
  @inject(FileNavigatorContribution) protected readonly navigatorContribution!: FileNavigatorContribution;
  @inject(RemoteConnectionProvider) protected readonly connectionProvider!: ServiceConnectionProvider;

  private bufferWatchActive = false;

  onStart(): void {
    window.addEventListener('beforeunload', () => {
      this.tilingLayoutService.saveAllSizes();
    });

    this.stateService.reachedState('ready').then(() => {
      this.tilingLayoutService.buildInitialLayout()
        .then(() => {
          if (!this.bufferWatchActive) {
            this.bufferWatchActive = true;
            this._startBufferWatch();
          }
        })
        .catch(err => this.messageService.error('Mineo: failed to build layout: ' + err));
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startBufferWatch(): void {
    // Connect buffer-watch to the primary editor PTY
    // Use the legacy path as fallback — the backend routes it to primary
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
}

/**
 * NvimOpenHandler intercepts file-open events from the File Explorer.
 * Always forwards file URIs to /api/nvim-open with priority 500,
 * targeting the currently focused pane via instanceId.
 */
@injectable()
class NvimOpenHandler implements OpenHandler {
  readonly id = 'mineo.nvim-open';
  readonly label = 'Open in Neovim';

  @inject(MessageService) protected readonly messageService!: MessageService;
  @inject(TilingLayoutService) protected readonly tilingLayoutService!: TilingLayoutService;
  @inject(LayoutTreeManager) protected readonly layoutTreeManager!: LayoutTreeManager;

  canHandle(uri: URI): number {
    if (uri.scheme !== 'file') return -1;
    return 500;
  }

  async open(uri: URI): Promise<object | undefined> {
    const filePath = uri.path.toString();
    try {
      // Build URL — target the focused pane's nvim instance if known
      let url = '/api/nvim-open?file=' + encodeURIComponent(filePath);
      const focusedLeafId = this.layoutTreeManager.focusedLeafId;
      if (focusedLeafId) {
        const found = this.layoutTreeManager.findLeaf(focusedLeafId);
        if (found && found.leaf.role === 'editor') {
          url += '&instanceId=' + encodeURIComponent(found.leaf.instanceId);
        }
      }
      const res = await fetch(url);
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
 * NavigatorTilingContribution — adds tiling-related context menu items to the
 * file explorer: "Open in New Pane", split/close pane, tab operations.
 * Always available regardless of editor mode.
 */
@injectable()
class NavigatorTilingContribution implements CommandContribution, MenuContribution {
  static readonly OPEN_IN_NEW_PANE = 'mineo.openInNewPane';

  @inject(TilingLayoutService) protected readonly tilingLayoutService!: TilingLayoutService;
  @inject(SelectionService) protected readonly selectionService!: SelectionService;

  private getSelectedFileUri(): URI | undefined {
    const uri = UriSelection.getUri(this.selectionService.selection);
    if (uri && uri.scheme === 'file') {
      return uri;
    }
    return undefined;
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(
      { id: NavigatorTilingContribution.OPEN_IN_NEW_PANE, label: 'Open in New Pane' },
      {
        execute: () => {
          const uri = this.getSelectedFileUri();
          if (uri) {
            this.tilingLayoutService.openFileInNewPane(uri.path.toString());
          }
        },
        isEnabled: () => !!this.getSelectedFileUri(),
        isVisible: () => !!this.getSelectedFileUri(),
      },
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    // "Open in New Pane" — for files only (command isVisible hides it when no file selected)
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, {
      commandId: NavigatorTilingContribution.OPEN_IN_NEW_PANE,
      label: 'Open in New Pane',
      order: '0.1',
      when: '!explorerResourceIsFolder',
    });

    // ── Pane operations ───────────────────────────────────────────────
    const PANE_GROUP = [...NavigatorContextMenu.NAVIGATION, 'mineo_pane'];
    menus.registerSubmenu(PANE_GROUP, 'Pane');
    menus.registerMenuAction(PANE_GROUP, {
      commandId: 'mineo.split.horizontal',
      label: 'Split Horizontal',
      order: 'a',
    });
    menus.registerMenuAction(PANE_GROUP, {
      commandId: 'mineo.split.vertical',
      label: 'Split Vertical',
      order: 'b',
    });
    menus.registerMenuAction(PANE_GROUP, {
      commandId: 'mineo.pane.terminal',
      label: 'Add Terminal',
      order: 'c',
    });
    menus.registerMenuAction(PANE_GROUP, {
      commandId: 'mineo.pane.close',
      label: 'Close Pane',
      order: 'd',
    });

    // ── Tab operations ────────────────────────────────────────────────
    const TAB_GROUP = [...NavigatorContextMenu.NAVIGATION, 'mineo_tab'];
    menus.registerSubmenu(TAB_GROUP, 'Tab');
    menus.registerMenuAction(TAB_GROUP, {
      commandId: 'mineo.tab.new',
      label: 'New Tab',
      order: 'a',
    });
    menus.registerMenuAction(TAB_GROUP, {
      commandId: 'mineo.tab.close',
      label: 'Close Tab',
      order: 'b',
    });
    menus.registerMenuAction(TAB_GROUP, {
      commandId: 'mineo.tab.next',
      label: 'Next Tab',
      order: 'c',
    });
    menus.registerMenuAction(TAB_GROUP, {
      commandId: 'mineo.tab.prev',
      label: 'Previous Tab',
      order: 'd',
    });
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // PaneRegistry — maps role strings to pane descriptors
  bind(PaneRegistry).toSelf().inSingletonScope();

  // Expose DI container reference for pane descriptors
  bind('DIContainer').toDynamicValue(ctx => ctx.container).inSingletonScope();

  // Register pane descriptors at module load time
  bind(FrontendApplicationContribution).toDynamicValue(ctx => {
    const registry = ctx.container.get(PaneRegistry);
    registry.register(neovimPaneDescriptor);
    registry.register(terminalPaneDescriptor);
    registry.register(monacoPaneDescriptor);
    return { onStart: () => {} } as any;
  }).inSingletonScope();

  // NvimWidget factory — creates NvimWidget instances with unique instanceIds
  bindNvimWidgetFactory(bind);

  // PtyControlService — frontend singleton for spawn/kill requests
  bind(PtyControlService).toSelf().inSingletonScope();

  // LayoutTreeManager — owns the workspace layout data model
  bind(LayoutTreeManager).toSelf().inSingletonScope();

  // TilingLayoutService — manages standalone TilingContainer tabs
  bind(TilingLayoutService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(TilingLayoutService);

  // Tiling commands and keybindings (split, close, navigate, resize, tab ops)
  bind(TilingCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(TilingCommandContribution);
  bind(KeybindingContribution).toService(TilingCommandContribution);

  // Register the Neovim file opener
  bind(OpenHandler).to(NvimOpenHandler).inSingletonScope();

  // Register navigator context menu contributions (Open in New Pane, Pane/Tab submenus)
  bind(NavigatorTilingContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(NavigatorTilingContribution);
  bind(MenuContribution).toService(NavigatorTilingContribution);

  // Register terminal startup contribution (manages tiling layout)
  bind(NvimTerminalContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NvimTerminalContribution);

  // Settings panel (bottom-left Manage gear / Cmd+,)
  bind(SettingsContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(SettingsContribution);
  bind(CommandContribution).toService(SettingsContribution);
  bind(KeybindingContribution).toService(SettingsContribution);
  bind(MenuContribution).toService(SettingsContribution);

  // Neovim preferences — adds "Extensions › Neovim" to Theia's Preferences panel
  bind(NvimPreferenceContribution).toSelf().inSingletonScope();
  bind(PreferenceContribution).toService(NvimPreferenceContribution);
  bind(NvimPreferenceSyncContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NvimPreferenceSyncContribution);

  // Touch scroll for Theia panels (explorer, sidebars)
  bind(FrontendApplicationContribution).to(TouchScrollContribution).inSingletonScope();

  // Monarch syntax highlighting — native Monaco line-by-line tokenizer
  bind(MonarchTokenizer).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).to(MonarchTokenizer).inSingletonScope();

  // LSP client — raw JSON-RPC over WebSocket for hover/completion/definition
  bind(LspClientManager).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).to(LspClientManager).inSingletonScope();

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
