/**
 * TilingContainer — a Lumino Widget that renders one tab's split tree
 * using nested SplitPanels.
 *
 * Each TilingContainer corresponds to one TabLayout and manages:
 * - Building the Lumino widget tree from a LayoutNode
 * - Incremental updates (split/close) without full rebuilds
 * - Pane header bars with split/close/drag controls
 * - PTY lifecycle delegated to PaneDescriptor.create/destroy
 */

import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { Widget, BoxPanel, BoxLayout, SplitPanel } from '@lumino/widgets';
import { Message, MessageLoop } from '@lumino/messaging';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { interfaces } from '@theia/core/shared/inversify';
import { NvimWidget } from './neovim-widget';
import { PtyControlService } from './pty-control-service';
import { LayoutTreeManager } from './layout-tree-manager';
import { PaneRegistry } from './panes/index';
import type { LayoutNode, LeafNode, SplitNode, TabLayout } from '../common/layout-types';

// ── Pane drag state (module-level so it works across containers) ──────────────
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

// ── PaneWrapper ───────────────────────────────────────────────────────────────

/**
 * PaneWrapper — a Panel that hosts an inner pane widget with a header bar.
 * Inheriting from Panel ensures Lumino correctly propagates layout messages (Resize, Attach).
 */
class PaneWrapper extends BaseWidget {
    private readonly headerEl: HTMLElement;
    private readonly contentPanel: BoxPanel;
    private innerWidget: Widget | undefined;

    constructor(
        leafId: string,
        private readonly leaf: LeafNode,
        private readonly paneRegistry: PaneRegistry,
        private readonly onSplitRequest: (direction: 'horizontal' | 'vertical', role: string) => void,
        private readonly onClose: () => void,
        private readonly onFocus: () => void,
    ) {
        super();
        this.id = 'mineo.pane-wrapper.' + leafId;
        this.addClass('mineo-pane-wrapper');
        
        // Use BoxLayout for the PaneWrapper (Header + Content)
        const mainLayout = new BoxLayout({ direction: 'top-to-bottom', spacing: 0 });
        this.layout = mainLayout;

        // Header Widget
        const header = new Widget();
        header.addClass('mineo-pane-header');
        this.headerEl = header.node;
        mainLayout.addWidget(header);
        // Explicitly set the height basis for the header so Lumino doesn't collapse it
        BoxLayout.setSizeBasis(header, 20);
        BoxLayout.setStretch(header, 0);

        // Content Panel (where the editor goes)
        this.contentPanel = new BoxPanel({ direction: 'top-to-bottom', spacing: 0 });
        this.contentPanel.addClass('mineo-pane-content');
        mainLayout.addWidget(this.contentPanel);
        BoxLayout.setStretch(this.contentPanel, 1);

        this.buildHeader();

        this.node.addEventListener('mousedown', () => this.onFocus(), true);
    }

    private buildHeader(): void {
        const descriptor = this.paneRegistry.get(this.leaf.role);

        // Drag grip
        const grip = document.createElement('div');
        grip.className = 'mineo-pane-header-drag';
        grip.draggable = true;
        grip.title = 'Drag to move pane';
        grip.innerHTML = '&#8801;'; // ≡
        this.headerEl.appendChild(grip);

        // Icon
        const icon = document.createElement('span');
        icon.className = `mineo-pane-header-icon ${descriptor?.icon ?? ''}`;
        this.headerEl.appendChild(icon);

        // Label
        const label = document.createElement('span');
        label.className = 'mineo-pane-header-label';
        label.textContent = descriptor?.label ?? this.leaf.role;
        this.headerEl.appendChild(label);

        // Actions container
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


    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        if (this.innerWidget) {
            this.innerWidget.activate();
        }
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        if (this.innerWidget instanceof NvimWidget) {
            requestAnimationFrame(() => {
                if (this.innerWidget instanceof NvimWidget) this.innerWidget.fitAndResize();
            });
        }
    }

    showPanePicker(anchor: HTMLElement, direction: 'horizontal' | 'vertical'): void {
        document.querySelector('.mineo-pane-picker')?.remove();

        const picker = document.createElement('div');
        picker.className = 'mineo-pane-picker';

        for (const desc of this.paneRegistry.getAll()) {
            const item = document.createElement('div');
            item.className = 'mineo-pane-picker-item';
            item.innerHTML =
                `<span class="mineo-pane-picker-item-icon ${desc.icon}"></span>` +
                `<span>${desc.label}</span>`;
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                picker.remove();
                this.onSplitRequest(direction, desc.role);
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
        if (this.innerWidget === widget) {
            widget.activate();
            return;
        }

        // If another widget was there, clear it.
        // We don't dispose as it might be cached in EditorManager/widgetPool.
        if (this.innerWidget) {
            this.contentPanel.layout!.removeWidget(this.innerWidget);
        }

        this.innerWidget = widget;
        this.contentPanel.addWidget(widget);
        BoxLayout.setStretch(widget, 1);
        
        // Ensure the editor knows its new size immediately
        requestAnimationFrame(() => {
            if (this.innerWidget === widget) {
                MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize);
                widget.update();
            }
        });

        widget.activate();
    }

    getInnerWidget(): Widget | undefined {
        return this.innerWidget;
    }

    get leafData(): { id: string; instanceId: string; role: string } {
        return { id: this.leaf.id, instanceId: this.leaf.instanceId, role: this.leaf.role };
    }
}

// ── TilingContainer ───────────────────────────────────────────────────────────

export class TilingContainer extends BaseWidget {
    /** Resolves when the current rebuildLayout() call completes. */
    pendingRebuild: Promise<void> = Promise.resolve();

    /** Map from leaf ID → PaneWrapper */
    private wrapperMap = new Map<string, PaneWrapper>();
    /** Map from split ID → SplitPanel */
    private splitMap = new Map<string, SplitPanel>();
    /** The root Lumino widget */
    private rootWidget: Widget | undefined;
    private tabLayout: TabLayout;

    private readonly _onPaneCloseRequest = new Emitter<{ tabId: string; leafId: string }>();
    readonly onPaneCloseRequest: Event<{ tabId: string; leafId: string }> = this._onPaneCloseRequest.event;

    private readonly _onSplitRequest = new Emitter<{ leafId: string; direction: 'horizontal' | 'vertical'; role: string }>();
    readonly onSplitRequest: Event<{ leafId: string; direction: 'horizontal' | 'vertical'; role: string }> = this._onSplitRequest.event;

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

        // Rebuild when the layout model changes for this tab
        this.toDispose.push(
            this.layoutTreeManager.onLayoutChange(() => {
                const freshTab = this.layoutTreeManager.layout.tabs.find(t => t.id === this.tabLayout.id);
                if (!freshTab) return; // tab was removed — TilingLayoutService handles shell cleanup
                this.tabLayout = freshTab;
                this.pendingRebuild = this.rebuildLayout();
            })
        );

        // Sync active-pane CSS whenever the model's focus changes
        this.toDispose.push(
            this.layoutTreeManager.onFocusChange(() => this.syncActivePaneCSS())
        );
    }

    /** Build the initial layout tree. Call after widget is attached. */
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

    /** Global pool of inner widgets, keyed by instanceId. Prevents black screen on drag. */
    private static widgetPool = new Map<string, Widget>();

    private async createLeafWrapper(leaf: LeafNode, spawnPty = true): Promise<PaneWrapper> {
        const wrapper = new PaneWrapper(
            leaf.id,
            leaf,
            this.paneRegistry,
            (direction, role) => {
                this._onSplitRequest.fire({ leafId: leaf.id, direction, role });
            },
            () => this._onPaneCloseRequest.fire({ tabId: this.tabLayout.id, leafId: leaf.id }),
            () => this.setActivePane(leaf.id),
        );

        // Try to reuse existing inner widget from the pool
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
                // Rebuild path — recreate without PTY spawn (PTYs are dead after page refresh)
                // For neovim/terminal, we skip spawn; the widget reconnects channels instead
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

        // Auto-close pane when Neovim/Terminal process exits
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
        this.layoutTreeManager.setFocusedLeaf(leafId);
    }

    private syncActivePaneCSS(): void {
        const focusedId = this.layoutTreeManager.focusedLeafId;
        for (const [id, wrapper] of this.wrapperMap) {
            wrapper.node.classList.toggle('mineo-pane-active', id === focusedId);
        }
    }

    focusLeaf(leafId: string): void {
        const wrapper = this.wrapperMap.get(leafId);
        if (!wrapper) return;
        const inner = wrapper.getInnerWidget();
        if (inner instanceof NvimWidget) {
            inner.focusTerminal();
        } else if (inner) {
            inner.activate();
        }
        this.setActivePane(leafId);
    }

    /** Get the wrapper widget for a leaf ID (used by TilingLayoutService context menu). */
    getWidget(leafId: string): Widget | undefined {
        return this.wrapperMap.get(leafId);
    }

    syncSizesToLayout(): void {
        for (const [splitId, panel] of this.splitMap) {
            const sizes = panel.relativeSizes();
            this.layoutTreeManager.resizeSplit(this.tabLayout.id, splitId, sizes);
        }
    }

    focusFirst(): void {
        const firstLeafId = this.wrapperMap.keys().next().value as string | undefined;
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
                if (inner instanceof NvimWidget) {
                    inner.fitAndResize();
                } else if (inner) {
                    MessageLoop.sendMessage(inner, Widget.ResizeMessage.UnknownSize);
                }
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
                if (inner instanceof NvimWidget) {
                    inner.fitAndResize();
                } else if (inner) {
                    MessageLoop.sendMessage(inner, Widget.ResizeMessage.UnknownSize);
                }
            }
        });
    }

    // ── Pane drag-and-drop ────────────────────────────────────────────────

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
                .forEach(el => el.classList.remove('mineo-drop-left', 'mineo-drop-right', 'mineo-drop-top', 'mineo-drop-bottom'));
        });

        node.addEventListener('dragover', (e: DragEvent) => {
            if (!e.dataTransfer!.types.includes('application/mineo-pane')) return;
            if (!_paneDrag || _paneDrag.srcLeafId === leaf.id) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer!.dropEffect = 'move';
            this.setDropIndicator(node, getDropZone(e, node));
        });

        node.addEventListener('dragleave', (e: DragEvent) => {
            if (!node.contains(e.relatedTarget as Node | null)) {
                this.clearDropIndicator(node);
            }
        });

        node.addEventListener('drop', async (e: DragEvent) => {
            if (!e.dataTransfer!.types.includes('application/mineo-pane')) return;
            e.preventDefault();
            e.stopPropagation();
            const drag = _paneDrag;
            _paneDrag = null;
            document.querySelectorAll('.mineo-drop-left,.mineo-drop-right,.mineo-drop-top,.mineo-drop-bottom')
                .forEach(el => el.classList.remove('mineo-drop-left', 'mineo-drop-right', 'mineo-drop-top', 'mineo-drop-bottom'));
            if (!drag || drag.srcLeafId === leaf.id) return;

            const zone = getDropZone(e, node);
            const srcInstanceId = drag.srcContainer.getInstanceIdForLeaf(drag.srcLeafId);
            const moved = this.layoutTreeManager.movePane(
                drag.srcTabId, drag.srcLeafId, this.tabLayout.id, leaf.id, zone,
            );
            if (!moved) return;

            drag.srcContainer.syncSizesToLayout();
            if (drag.srcContainer !== this) this.syncSizesToLayout();

            await drag.srcContainer.rebuildLayout();
            if (drag.srcContainer !== this) await this.rebuildLayout();

            requestAnimationFrame(() => this.focusLeafByInstanceId(srcInstanceId ?? ''));
        });
    }

    private setDropIndicator(node: HTMLElement, zone: DropZone): void {
        node.classList.remove('mineo-drop-left', 'mineo-drop-right', 'mineo-drop-top', 'mineo-drop-bottom');
        node.classList.add(`mineo-drop-${zone}`);
    }

    private clearDropIndicator(node: HTMLElement): void {
        node.classList.remove('mineo-drop-left', 'mineo-drop-right', 'mineo-drop-top', 'mineo-drop-bottom');
    }

    private detachWidgetsFromLumino(widget: Widget): void {
        if (widget instanceof PaneWrapper) {
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

        this.syncActivePaneCSS();
        requestAnimationFrame(() => {
            for (const [, w] of this.wrapperMap) {
                const inner = w.getInnerWidget();
                if (inner instanceof NvimWidget) inner.fitAndResize();
            }
        });
    }

    override dispose(): void {
        for (const [, wrapper] of this.wrapperMap) {
            const inner = wrapper.getInnerWidget();
            const { instanceId, role } = wrapper.leafData;

            if (inner) {
                TilingContainer.widgetPool.delete(instanceId);
                const descriptor = this.paneRegistry.get(role);
                descriptor?.destroy?.(inner, instanceId);
            }
            if (role === 'neovim' || role === 'terminal') {
                this.ptyControlService.kill(instanceId).catch(() => {});
            }
            wrapper.dispose();
        }
        this.wrapperMap.clear();
        this.splitMap.clear();
        super.dispose();
    }
}
