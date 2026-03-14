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
 * PaneWrapper — a BaseWidget that hosts an inner pane widget with a header bar.
 * Layout: flex column — 24px header + flex:1 content area.
 */
class PaneWrapper extends BaseWidget {
    private readonly headerEl: HTMLElement;
    private readonly contentEl: HTMLElement;
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
        this.node.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;position:relative;';

        this.headerEl = document.createElement('div');
        this.headerEl.className = 'mineo-pane-header';
        this.node.appendChild(this.headerEl);

        this.contentEl = document.createElement('div');
        this.contentEl.className = 'mineo-pane-content';
        this.node.appendChild(this.contentEl);

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
        this.innerWidget = widget;
        this.contentEl.appendChild(widget.node);
    }

    getInnerWidget(): Widget | undefined {
        return this.innerWidget;
    }

    get leafData(): { id: string; instanceId: string; role: string } {
        return { id: this.leaf.id, instanceId: this.leaf.instanceId, role: this.leaf.role };
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        if (this.innerWidget instanceof NvimWidget) {
            requestAnimationFrame(() => {
                if (this.innerWidget instanceof NvimWidget) this.innerWidget.fitAndResize();
            });
        }
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.innerWidget instanceof NvimWidget) {
            requestAnimationFrame(() => {
                if (this.innerWidget instanceof NvimWidget) this.innerWidget.fitAndResize();
            });
        }
    }
}

// ── TilingContainer ───────────────────────────────────────────────────────────

export class TilingContainer extends BaseWidget {
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
        for (const [id, wrapper] of this.wrapperMap) {
            wrapper.node.classList.toggle('mineo-pane-active', id === leafId);
        }
        this.layoutTreeManager.setFocusedLeaf(leafId);
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
        const found = this.layoutTreeManager.findLeaf(leafId);

        if (inner && found) {
            TilingContainer.widgetPool.delete(found.leaf.instanceId);
            const descriptor = this.paneRegistry.get(found.leaf.role);
            descriptor?.destroy?.(inner, found.leaf.instanceId);
            // Kill PTY for PTY-backed panes
            if (found.leaf.role === 'neovim' || found.leaf.role === 'terminal') {
                this.ptyControlService.kill(found.leaf.instanceId).catch(() => {});
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
