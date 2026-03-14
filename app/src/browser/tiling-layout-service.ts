/**
 * TilingLayoutService — manages TilingContainer widgets as standalone Theia tabs.
 * Injects "+" and "⚙" buttons into Theia's main tab bar.
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { interfaces } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { BaseWidget, Widget, Message } from '@theia/core/lib/browser/widgets/widget';
import { TilingContainer } from './tiling-container';
import { PtyControlService } from './pty-control-service';
import { LayoutTreeManager } from './layout-tree-manager';
import type { TabLayout } from '../common/layout-types';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { SettingsCommands } from './settings-widget';
import { PaneRegistry } from './panes/index';

@injectable()
export class TilingLayoutService {
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(PtyControlService) private readonly ptyControlService!: PtyControlService;
    @inject(LayoutTreeManager) private readonly layoutTreeManager!: LayoutTreeManager;
    @inject(CommandRegistry) private readonly commandRegistry!: CommandRegistry;
    @inject(PaneRegistry) private readonly paneRegistry!: PaneRegistry;
    @inject('DIContainer') private readonly diContainer!: interfaces.Container;

    private containers = new Map<string, TilingContainer>();
    private initialized = false;

    @postConstruct()
    protected init(): void {
        // Use a debounced sync to avoid thrashing during rapid drags/splits
        let syncTimeout: any;
        this.layoutTreeManager.onLayoutChange(() => {
            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(() => this.syncContainersWithModel(), 50);
        });

        // Add buttons to Theia tab bar
        this.injectTabBarButtons();
    }

    /** Sync our container widgets with the model's tabs. */
    private syncContainersWithModel(): void {
        const modelTabs = this.layoutTreeManager.layout.tabs;
        const modelTabIds = new Set(modelTabs.map(t => t.id));

        // 1. Remove containers for tabs that are gone
        for (const [id, container] of this.containers) {
            if (!modelTabIds.has(id)) {
                this.containers.delete(id);
                this.shell.closeWidget(container.id);
            }
        }

        // 2. Add containers for new tabs
        for (const tabLayout of modelTabs) {
            if (!this.containers.has(tabLayout.id)) {
                this.createTab(tabLayout, false); // Don't activate by default
            }
        }

        // 3. Ensure the active tab from the model is active in the shell
        const activeTabIndex = this.layoutTreeManager.layout.activeTabIndex;
        const activeTab = this.layoutTreeManager.layout.tabs[activeTabIndex];
        if (activeTab) {
            const activeContainer = this.containers.get(activeTab.id);
            if (activeContainer && !activeContainer.isAttached) {
                this.shell.activateWidget(activeContainer.id);
            }
        }
    }

    /** Build the initial layout from LayoutTreeManager. */
    async buildInitialLayout(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        const layout = this.layoutTreeManager.layout;
        for (const tabLayout of layout.tabs) {
            if (!this.containers.has(tabLayout.id)) {
                this.createTab(tabLayout, false);
            }
        }

        // Activate the stored active tab
        if (layout.activeTabIndex >= 0 && layout.activeTabIndex < layout.tabs.length) {
            const tabId = layout.tabs[layout.activeTabIndex].id;
            const widget = this.containers.get(tabId);
            if (widget) {
                this.shell.activateWidget(widget.id);
            }
        }
    }

    /** Create a TilingContainer for a tab and add it to the ApplicationShell. */
    private createTab(tabLayout: TabLayout, activate = true): TilingContainer {
        const container = new TilingContainer(
            tabLayout,
            this.paneRegistry,
            this.ptyControlService,
            this.layoutTreeManager,
            this.shell,
            this.diContainer,
        );
        this.containers.set(tabLayout.id, container);
        
        container.onPaneCloseRequest(({ tabId, leafId }) => {
            this.closePaneById(tabId, leafId);
        });

        container.onSplitRequest(({ leafId, direction, role }) => {
            const tabId = this.getTabIdForContainer(container);
            if (tabId) {
                this.splitPaneByLeafId(tabId, leafId, direction, role);
            }
        });

        // Add directly to main area — Theia creates a tab
        this.shell.addWidget(container, { area: 'main' });
        if (activate) {
            this.shell.activateWidget(container.id);
        }
        
        // Build the layout tree
        container.buildLayout();

        return container;
    }

    /** Add a new tab with a default editor pane. */
    async addNewTab(role: string = 'neovim'): Promise<void> {
        const tabLayout = this.layoutTreeManager.addTab(role);
        const container = this.createTab(tabLayout);
        this.shell.activateWidget(container.id);
        requestAnimationFrame(() => container.focusFirst());
    }

    /** Close a tab by its tabId. */
    async closeTab(tabId: string): Promise<void> {
        const container = this.containers.get(tabId);
        if (!container) return;

        // Sync sizes before closing
        container.syncSizesToLayout();

        this.containers.delete(tabId);
        this.shell.closeWidget(container.id);
        this.layoutTreeManager.removeTab(tabId);

        // If no tabs left, the layout manager creates a default — we need to build it
        if (this.containers.size === 0) {
            const layout = this.layoutTreeManager.layout;
            if (layout.tabs.length > 0) {
                const newContainer = this.createTab(layout.tabs[0]);
                this.shell.activateWidget(newContainer.id);
            }
        }
    }

    /** Close the active tab. */
    async closeActiveTab(): Promise<void> {
        const active = this.getActiveContainer();
        if (!active) return;
        
        const tabId = this.getActiveTabId();
        if (tabId) {
            await this.closeTab(tabId);
        }
    }

    /** Switch to next tab. */
    nextTab(): void {
        this.layoutTreeManager.nextTab();
        const active = this.layoutTreeManager.activeTab;
        if (active) {
            const widget = this.containers.get(active.id);
            if (widget) this.shell.activateWidget(widget.id);
        }
    }

    /** Switch to previous tab. */
    prevTab(): void {
        this.layoutTreeManager.prevTab();
        const active = this.layoutTreeManager.activeTab;
        if (active) {
            const widget = this.containers.get(active.id);
            if (widget) this.shell.activateWidget(widget.id);
        }
    }

    /** Get the active TilingContainerBased on the layout model's focus. */
    getActiveContainer(): TilingContainer | undefined {
        const activeTab = this.layoutTreeManager.activeTab;
        if (activeTab) {
            return this.containers.get(activeTab.id);
        }
        return undefined;
    }

    /** Get the active tab ID. */
    getActiveTabId(): string | undefined {
        const activeTab = this.layoutTreeManager.activeTab;
        return activeTab?.id;
    }

    /** Split the focused pane. */
    async splitFocusedPane(direction: 'horizontal' | 'vertical', role: string = 'neovim'): Promise<void> {
        const tabId = this.getActiveTabId();
        let leafId = this.layoutTreeManager.focusedLeafId;
        if (!tabId) return;

        // If no leaf is focused (e.g. in Monaco mode), fallback to the first leaf of the active tab
        if (!leafId) {
            const leaves = this.layoutTreeManager.getTabLeaves(tabId);
            if (leaves.length > 0) leafId = leaves[0].id;
        }
        if (!leafId) return;

        const container = this.getActiveContainer();
        if (!container) return;

        // Update the layout model
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
    }

    /** Close the focused pane. */
    async closeFocusedPane(): Promise<void> {
        const tabId = this.getActiveTabId();
        let leafId = this.layoutTreeManager.focusedLeafId;
        if (!tabId) return;

        if (!leafId) {
            const leaves = this.layoutTreeManager.getTabLeaves(tabId);
            if (leaves.length > 0) leafId = leaves[0].id;
        }
        if (!leafId) return;

        await this.closePaneById(tabId, leafId);
    }

    /** Close a specific pane by tab + leaf ID. */
    async closePaneById(tabId: string, leafId: string): Promise<void> {
        const container = this.containers.get(tabId);
        if (!container) return;

        const found = this.layoutTreeManager.findLeaf(leafId);
        if (found) {
            await this.ptyControlService.kill(found.leaf.instanceId).catch(() => { /* ignore */ });
        }

        this.layoutTreeManager.closePane(tabId, leafId);

        const tabStillExists = this.layoutTreeManager.layout.tabs.some(t => t.id === tabId);
        if (!tabStillExists) {
            this.containers.delete(tabId);
            this.shell.closeWidget(container.id);

            if (this.containers.size === 0) {
                const layout = this.layoutTreeManager.layout;
                if (layout.tabs.length > 0) {
                    const newContainer = this.createTab(layout.tabs[0]);
                    this.shell.activateWidget(newContainer.id);
                    requestAnimationFrame(() => newContainer.focusFirst());
                }
            }
        } else {
            await container.handleClose(leafId);
            const leaves = this.layoutTreeManager.getTabLeaves(tabId);
            if (leaves.length > 0) {
                container.focusLeaf(leaves[0].id);
            }
        }
    }

    /** Navigate focus in a direction. */
    navigateFocus(direction: 'left' | 'right' | 'up' | 'down'): void {
        const tabId = this.getActiveTabId();
        let leafId = this.layoutTreeManager.focusedLeafId;
        if (!tabId) return;

        if (!leafId) {
            const leaves = this.layoutTreeManager.getTabLeaves(tabId);
            if (leaves.length > 0) leafId = leaves[0].id;
        }
        if (!leafId) return;

        const target = this.layoutTreeManager.getAdjacentLeaf(tabId, leafId, direction);
        if (!target) return;

        const container = this.getActiveContainer();
        if (container) {
            container.focusLeaf(target.id);
        }
    }

    /** Open a file in a new pane. */
    async openFileInNewPane(filePath: string): Promise<void> {
        const tabId = this.getActiveTabId();
        let leafId = this.layoutTreeManager.focusedLeafId;
        if (!tabId) return;

        if (!leafId) {
            const leaves = this.layoutTreeManager.getTabLeaves(tabId);
            if (leaves.length > 0) leafId = leaves[0].id;
        }
        if (!leafId) return;

        const container = this.getActiveContainer();
        if (!container) return;

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

        try {
            const url = '/api/nvim-open?file=' + encodeURIComponent(filePath)
                + '&instanceId=' + encodeURIComponent(newLeaf.instanceId);
            await fetch(url);
        } catch {
            // ignore
        }
    }

    private findSplitContaining(node: any, childId: string): any {
        if (node.type === 'split') {
            for (const child of node.children) {
                if (child.id === childId) return node;
                const found = this.findSplitContaining(child, childId);
                if (found) return found;
            }
        }
        return null;
    }

    private getTabIdForContainer(container: TilingContainer): string | undefined {
        for (const [tabId, c] of this.containers) {
            if (c === container) return tabId;
        }
        return undefined;
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

    /** Inject "+" and "⚙" buttons into Theia's main tab bar. */
    private injectTabBarButtons(): void {
        const selector = '#theia-main-content-panel > .lm-TabBar';
        
        const inject = () => {
            const tabBar = document.querySelector(selector) as HTMLElement | null;
            if (!tabBar || tabBar.querySelector('.mineo-tab-bar-buttons')) return;

            const container = document.createElement('div');
            container.className = 'mineo-tab-bar-buttons';

            // New Tab button
            const addBtn = document.createElement('button');
            addBtn.className = 'mineo-tab-new-btn';
            addBtn.textContent = '+';
            addBtn.title = 'New tab (Ctrl+Shift+T)';
            addBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.addNewTab();
            });
            container.appendChild(addBtn);

            // Settings gear button
            const gearBtn = document.createElement('button');
            gearBtn.className = 'mineo-tab-new-btn';
            gearBtn.textContent = '⚙';
            gearBtn.title = 'Mineo Settings';
            gearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.commandRegistry.executeCommand(SettingsCommands.OPEN.id);
            });
            container.appendChild(gearBtn);

            tabBar.appendChild(container);

            // Tab bar context menu
            tabBar.addEventListener('contextmenu', (e: MouseEvent) => {
                const tabEl = (e.target as Element).closest('.lm-TabBar-tab') as HTMLElement | null;
                const tabs = Array.from(tabBar.querySelectorAll('.lm-TabBar-tab'));
                const tabIndex = tabEl ? tabs.indexOf(tabEl) : -1;

                e.preventDefault();
                e.stopPropagation();
                this.showTabContextMenu(e.clientX, e.clientY, tabIndex);
            });
        };

        // Target the main content panel specifically to reduce overhead
        const observer = new MutationObserver(() => inject());
        const target = document.querySelector('#theia-main-content-panel');
        if (target) {
            observer.observe(target, { childList: true });
        } else {
            // Fallback but without subtree:true to prevent performance issues
            observer.observe(document.body, { childList: true });
        }
        requestAnimationFrame(() => inject());
    }

    /** Show a context menu at the given screen position for the given tab index (-1 = no tab). */
    private showTabContextMenu(x: number, y: number, tabIndex: number): void {
        this.removeTabContextMenu();

        const menu = document.createElement('div');
        menu.className = 'mineo-tab-context-menu';
        menu.dataset.menuId = 'tab-ctx';

        const addItem = (label: string, shortcut: string, action: () => void, danger = false): void => {
            const item = document.createElement('div');
            item.className = 'mineo-tab-context-item' + (danger ? ' mineo-tab-context-item--danger' : '');
            item.innerHTML = `<span class="mineo-tab-context-label">${label}</span>`
                + (shortcut ? `<span class="mineo-tab-context-shortcut">${shortcut}</span>` : '');
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.removeTabContextMenu();
                action();
            });
            menu.appendChild(item);
        };

        const addSeparator = (): void => {
            const sep = document.createElement('div');
            sep.className = 'mineo-tab-context-separator';
            menu.appendChild(sep);
        };

        if (tabIndex >= 0) {
            const layout = this.layoutTreeManager.layout;
            const targetTab = layout.tabs[tabIndex];

            addItem('Close Tab', '⌘⇧W', () => {
                if (targetTab) this.closeTab(targetTab.id);
            }, true);

            addSeparator();
        }

        addItem('New Tab', '⌘⇧T', () => this.addNewTab());
        addItem('Next Tab', '⌘⇧]', () => this.nextTab());
        addItem('Prev Tab', '⌘⇧[', () => this.prevTab());

        addSeparator();

        addItem('Split Horizontal', '⌘⇧\\', () => this.splitFocusedPane('horizontal'));
        addItem('Split Vertical', '⌘⇧-', () => this.splitFocusedPane('vertical'));
        for (const desc of this.paneRegistry.getAll()) {
            addItem(`Add ${desc.label}`, '', () => this.splitFocusedPane('vertical', desc.role));
        }

        addSeparator();

        const activeContainer = this.getActiveContainer();
        const activeTabId = this.getActiveTabId();
        if (activeContainer && activeTabId) {
            const leaves = this.layoutTreeManager.getTabLeaves(activeTabId);
            if (leaves.length === 1) {
                addItem('Close Pane', '⌘⇧X', () => this.closeFocusedPane(), true);
            } else {
                const submenuWrapper = document.createElement('div');
                submenuWrapper.className = 'mineo-tab-context-submenu-wrapper';

                const trigger = document.createElement('div');
                trigger.className = 'mineo-tab-context-item mineo-tab-context-item--danger';
                trigger.innerHTML =
                    '<span class="mineo-tab-context-label">Close Pane</span>' +
                    '<span class="mineo-tab-context-submenu-arrow">›</span>';
                submenuWrapper.appendChild(trigger);

                const submenu = document.createElement('div');
                submenu.className = 'mineo-tab-context-submenu';

                leaves.forEach((leaf, idx) => {
                    const paneItem = document.createElement('div');
                    paneItem.className = 'mineo-tab-context-item mineo-tab-context-item--danger';
                    const isFocused = leaf.id === this.layoutTreeManager.focusedLeafId;
                    const roleIcon = leaf.role === 'terminal' ? '⌨' : leaf.role === 'monaco' ? '⊞' : '⬡';
                    paneItem.innerHTML =
                        `<span class="mineo-tab-context-label">${roleIcon} Pane ${idx + 1}` +
                        (isFocused ? ' <span class="mineo-tab-context-focused-badge">focused</span></span>' : '</span>');

                    const widget = activeContainer.getWidget(leaf.id);
                    paneItem.addEventListener('mouseenter', () => widget?.node.classList.add('mineo-pane-close-preview'));
                    paneItem.addEventListener('mouseleave', () => widget?.node.classList.remove('mineo-pane-close-preview'));
                    paneItem.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        widget?.node.classList.remove('mineo-pane-close-preview');
                        this.removeTabContextMenu();
                        this.closePaneById(activeTabId, leaf.id);
                    });
                    submenu.appendChild(paneItem);
                });

                submenuWrapper.appendChild(submenu);
                menu.appendChild(submenuWrapper);
            }
        } else {
            addItem('Close Pane', '⌘⇧X', () => this.closeFocusedPane(), true);
        }

        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 8);
        const top = Math.min(y, window.innerHeight - rect.height - 8);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        const dismiss = (e: MouseEvent | KeyboardEvent): void => {
            if (e instanceof KeyboardEvent && (e as KeyboardEvent).key !== 'Escape') return;
            this.removeTabContextMenu();
            document.removeEventListener('mousedown', dismiss as EventListener);
            document.removeEventListener('keydown', dismiss as EventListener);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', dismiss as EventListener);
            document.addEventListener('keydown', dismiss as EventListener);
        }, 0);
    }

    private removeTabContextMenu(): void {
        const existing = document.querySelector('.mineo-tab-context-menu');
        existing?.remove();
    }

    /** Save all container sizes. */
    saveAllSizes(): void {
        for (const [, container] of this.containers) {
            container.syncSizesToLayout();
        }
        this.layoutTreeManager.save();
    }
}
