/**
 * LayoutTreeManager — owns the workspace layout data model.
 *
 * Provides mutation methods (split, close, navigate, resize, tab ops),
 * fires change events, and persists to localStorage.
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import type {
    WorkspaceLayout,
    TabLayout,
    LayoutNode,
    LeafNode,
    SplitNode,
    PtyInstanceId,
    PaneRole,
} from '../common/layout-types';

const STORAGE_KEY = 'mineo.tiling-layout';

/** Generate a UUID v4. */
function uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/** Create a default layout: one tab with one editor pane. */
function defaultLayout(): WorkspaceLayout {
    return {
        version: 2,
        activeTabIndex: 0,
        tabs: [{
            id: uuid(),
            label: 'Tab 1',
            root: {
                type: 'leaf',
                id: uuid(),
                role: 'neovim',
                instanceId: uuid(),
            },
        }],
    };
}

/** Walk all leaf nodes in a layout node. */
function* walkLeaves(node: LayoutNode): Generator<LeafNode> {
    if (node.type === 'leaf') {
        yield node;
    } else {
        for (const child of node.children) {
            yield* walkLeaves(child);
        }
    }
}

/** Find a node by id in the tree. Returns the node and its parent (if any). */
function findNode(root: LayoutNode, id: string): { node: LayoutNode; parent: SplitNode | null; index: number } | null {
    if (root.id === id) {
        return { node: root, parent: null, index: -1 };
    }
    if (root.type === 'split') {
        for (let i = 0; i < root.children.length; i++) {
            if (root.children[i].id === id) {
                return { node: root.children[i], parent: root, index: i };
            }
            const result = findNode(root.children[i], id);
            if (result) return result;
        }
    }
    return null;
}

/** Regenerate all instanceIds in a layout tree (for restore — PTYs are dead). */
function regenerateInstanceIds(node: LayoutNode): void {
    if (node.type === 'leaf') {
        node.instanceId = uuid();
    } else {
        for (const child of node.children) {
            regenerateInstanceIds(child);
        }
    }
}

/** Migrate v1 role names to v2. */
function migrateV1Roles(node: LayoutNode): void {
    if (node.type === 'leaf') {
        if ((node.role as string) === 'editor') node.role = 'neovim';
        if ((node.role as string) === 'widget') node.role = 'neovim';
    } else {
        for (const child of node.children) {
            migrateV1Roles(child);
        }
    }
}

@injectable()
export class LayoutTreeManager {
    private _layout: WorkspaceLayout;
    private _focusedLeafId: string | undefined;
    private _saveTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly _onLayoutChange = new Emitter<WorkspaceLayout>();
    readonly onLayoutChange: Event<WorkspaceLayout> = this._onLayoutChange.event;

    private readonly _onFocusChange = new Emitter<string | undefined>();
    readonly onFocusChange: Event<string | undefined> = this._onFocusChange.event;

    constructor() {
        this._layout = this.restore();
    }

    get layout(): WorkspaceLayout {
        return this._layout;
    }

    get focusedLeafId(): string | undefined {
        return this._focusedLeafId;
    }

    get activeTab(): TabLayout | undefined {
        return this._layout.tabs[this._layout.activeTabIndex];
    }

    // ── Tab operations ─────────────────────────────────────────────────────

    addTab(role: PaneRole = 'neovim'): TabLayout {
        const tab: TabLayout = {
            id: uuid(),
            label: `Tab ${this._layout.tabs.length + 1}`,
            root: {
                type: 'leaf',
                id: uuid(),
                role,
                instanceId: uuid(),
            },
        };
        this._layout.tabs.push(tab);
        this._layout.activeTabIndex = this._layout.tabs.length - 1;
        this.fireAndSave();
        return tab;
    }

    removeTab(tabId: string): void {
        const idx = this._layout.tabs.findIndex(t => t.id === tabId);
        if (idx < 0) return;
        this._layout.tabs.splice(idx, 1);
        if (this._layout.tabs.length === 0) {
            // Last tab closed — create default
            this._layout = defaultLayout();
        } else {
            // Adjust active index
            if (this._layout.activeTabIndex >= this._layout.tabs.length) {
                this._layout.activeTabIndex = this._layout.tabs.length - 1;
            }
        }
        this.fireAndSave();
    }

    setActiveTab(index: number): void {
        if (index >= 0 && index < this._layout.tabs.length) {
            this._layout.activeTabIndex = index;
            this.fireAndSave();
        }
    }

    setActiveTabById(tabId: string): void {
        const idx = this._layout.tabs.findIndex(t => t.id === tabId);
        if (idx >= 0) {
            this.setActiveTab(idx);
        }
    }

    nextTab(): void {
        if (this._layout.tabs.length <= 1) return;
        this.setActiveTab((this._layout.activeTabIndex + 1) % this._layout.tabs.length);
    }

    prevTab(): void {
        if (this._layout.tabs.length <= 1) return;
        this.setActiveTab(
            (this._layout.activeTabIndex - 1 + this._layout.tabs.length) % this._layout.tabs.length
        );
    }

    /**
     * Reorder tabs to match the given array of tab IDs.
     * IDs not found in the current layout are ignored.
     */
    reorderTabs(orderedIds: string[]): void {
        const tabMap = new Map(this._layout.tabs.map(t => [t.id, t]));
        const reordered = orderedIds.map(id => tabMap.get(id)).filter((t): t is TabLayout => !!t);
        // Append any tabs that weren't in orderedIds (safety net)
        for (const tab of this._layout.tabs) {
            if (!reordered.find(t => t.id === tab.id)) {
                reordered.push(tab);
            }
        }
        this._layout.tabs = reordered;
        this.fireAndSave();
    }

    // ── Split operations ───────────────────────────────────────────────────

    /**
     * Move a pane (srcLeafId) from its current tab to be a split-sibling
     * of a target pane (targetLeafId) in another (or same) tab.
     * @returns true on success.
     */
    movePane(
        srcTabId: string,
        srcLeafId: string,
        targetTabId: string,
        targetLeafId: string,
        direction: 'left' | 'right' | 'top' | 'bottom',
    ): boolean {
        if (srcLeafId === targetLeafId) return false;

        const srcTab = this._layout.tabs.find(t => t.id === srcTabId);
        const targetTab = this._layout.tabs.find(t => t.id === targetTabId);
        if (!srcTab || !targetTab) return false;

        // 1. Pull the source node out of its tree
        const srcFound = findNode(srcTab.root, srcLeafId);
        if (!srcFound) return false;
        const srcNode = srcFound.node as LeafNode;

        const isOnlyPane = !srcFound.parent && srcTab.root.id === srcLeafId;

        if (isOnlyPane) {
            this._layout.tabs = this._layout.tabs.filter(t => t.id !== srcTabId);
            // If the target tab was the source tab, it's now gone.
            // If it was the last tab, defaultLayout will be created.
            // If it's not the last tab, activeTabIndex needs adjustment.
            if (this._layout.tabs.length === 0) {
                this._layout = defaultLayout();
            } else if (this._layout.activeTabIndex >= this._layout.tabs.length) {
                this._layout.activeTabIndex = this._layout.tabs.length - 1;
            }
        } else if (srcFound.parent) {
            const p = srcFound.parent;
            p.children.splice(srcFound.index, 1);
            p.sizes.splice(srcFound.index, 1);
            const total = p.sizes.reduce((a, b) => a + b, 0);
            if (total > 0) p.sizes = p.sizes.map(s => s / total);
            
            if (p.children.length === 1) {
                const survivor = p.children[0];
                if (srcTab.root.id === p.id) {
                    srcTab.root = survivor;
                } else {
                    const pFound = findNode(srcTab.root, p.id);
                    if (pFound && pFound.parent) {
                        pFound.parent.children[pFound.index] = survivor;
                    }
                }
            }
        }

        // 2. Re-find the target in the target tab (tree might have changed if same tab)
        // Note: If srcTabId === targetTabId and srcTab was removed, targetTab will be undefined.
        // This case is handled by the initial `if (!srcTab || !targetTab)` check if srcTab is removed.
        // If srcTab is removed, and targetTab was the same, then targetTab is now gone.
        // The logic below assumes targetTab still exists.
        // If srcTab was removed, and targetTab was different, then targetTab still exists.
        // If srcTab was NOT removed, and targetTab was the same, then targetTab still exists.
        // So, if srcTab was removed, we should not proceed with inserting into targetTab.
        if (isOnlyPane && srcTabId === targetTabId) {
            // The source tab was removed, and it was also the target tab.
            // The pane is effectively "moved" by being the new root of the default layout,
            // but the current `srcNode` is not directly inserted into `targetTab.root`
            // because `targetTab` no longer exists in its original form.
            // The default layout already has a root, so we need to replace it.
            if (this._layout.tabs.length > 0) {
                this._layout.tabs[this._layout.activeTabIndex].root = srcNode;
            }
            this.fireAndSave();
            return true;
        }

        // If targetTab is now undefined (e.g., if srcTab was removed and targetTab was the same tab)
        // this check will catch it.
        const currentTargetTab = this._layout.tabs.find(t => t.id === targetTabId);
        if (!currentTargetTab) {
            // This can happen if srcTab was removed and targetTab was the same tab,
            // and the above `if (isOnlyPane && srcTabId === targetTabId)` block didn't fully handle it,
            // or if targetTab was removed by some other means (e.g., if it was empty and got cleaned up).
            // For now, we'll just return false, implying the move failed to place the pane.
            // A more robust solution might involve creating a new tab for srcNode.
            return false;
        }

        const tgtFound = findNode(currentTargetTab.root, targetLeafId);
        if (!tgtFound) {
            // Target disappeared — make src the new root of target tab
            targetTab.root = srcNode;
            this.fireAndSave();
            return true;
        }

        const splitDirection: 'horizontal' | 'vertical' =
            direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
        const srcFirst = direction === 'left' || direction === 'top';

        const newSplit: SplitNode = {
            type: 'split',
            id: uuid(),
            direction: splitDirection,
            children: srcFirst ? [srcNode, tgtFound.node] : [tgtFound.node, srcNode],
            sizes: [0.5, 0.5],
        };

        if (!tgtFound.parent) {
            targetTab.root = newSplit;
        } else {
            tgtFound.parent.children[tgtFound.index] = newSplit;
        }

        this.fireAndSave();
        return true;
    }

    /**
     * Split a pane. Wraps the existing leaf in a SplitNode with a new leaf sibling.
     * @returns The new leaf node, or null if the split failed.
     */
    splitPane(
        tabId: string,
        leafId: string,
        direction: 'horizontal' | 'vertical',
        newRole: PaneRole = 'neovim',
        ratio: number = 0.5,
    ): LeafNode | null {
        const tab = this._layout.tabs.find(t => t.id === tabId);
        if (!tab) return null;

        const newLeaf: LeafNode = {
            type: 'leaf',
            id: uuid(),
            role: newRole,
            instanceId: uuid(),
        };

        if (tab.root.id === leafId) {
            // Root is the leaf — replace root with a SplitNode
            const newSplit: SplitNode = {
                type: 'split',
                id: uuid(),
                direction,
                children: [tab.root, newLeaf],
                sizes: [ratio, 1 - ratio],
            };
            tab.root = newSplit;
        } else {
            // Find the leaf and its parent
            const found = findNode(tab.root, leafId);
            if (!found || !found.parent) return null;

            const parent = found.parent;
            const idx = found.index;

            const newSplit: SplitNode = {
                type: 'split',
                id: uuid(),
                direction,
                children: [found.node, newLeaf],
                sizes: [ratio, 1 - ratio],
            };

            parent.children[idx] = newSplit;
        }

        this.fireAndSave();
        return newLeaf;
    }

    // ── Close operations ───────────────────────────────────────────────────

    /**
     * Close a pane. Removes the leaf and collapses the parent SplitNode
     * if only one child remains.
     * @returns instanceIds of killed PTYs
     */
    closePane(tabId: string, leafId: string): PtyInstanceId[] {
        const tab = this._layout.tabs.find(t => t.id === tabId);
        if (!tab) return [];

        // Collect instanceIds to kill
        const killed: PtyInstanceId[] = [];

        if (tab.root.id === leafId && tab.root.type === 'leaf') {
            // Closing the only pane — close the tab
            killed.push(tab.root.instanceId);
            this.removeTab(tabId);
            return killed;
        }

        const found = findNode(tab.root, leafId);
        if (!found || !found.parent) return [];

        // Collect instanceIds from the node being removed
        if (found.node.type === 'leaf') {
            killed.push(found.node.instanceId);
        } else {
            for (const leaf of walkLeaves(found.node)) {
                killed.push(leaf.instanceId);
            }
        }

        const parent = found.parent;
        const idx = found.index;

        // Remove the child
        parent.children.splice(idx, 1);
        parent.sizes.splice(idx, 1);

        // Normalize sizes
        const total = parent.sizes.reduce((a, b) => a + b, 0);
        if (total > 0) {
            parent.sizes = parent.sizes.map(s => s / total);
        }

        // If only one child remains, collapse the parent
        if (parent.children.length === 1) {
            const survivor = parent.children[0];
            // Replace parent with survivor
            if (tab.root.id === parent.id) {
                tab.root = survivor;
            } else {
                const parentFound = findNode(tab.root, parent.id);
                if (parentFound && parentFound.parent) {
                    parentFound.parent.children[parentFound.index] = survivor;
                }
            }
        }

        this.fireAndSave();
        return killed;
    }

    // ── Resize ─────────────────────────────────────────────────────────────

    resizeSplit(tabId: string, splitId: string, sizes: number[]): void {
        const tab = this._layout.tabs.find(t => t.id === tabId);
        if (!tab) return;
        const found = findNode(tab.root, splitId);
        if (!found || found.node.type !== 'split') return;
        (found.node as SplitNode).sizes = sizes;
        this.debouncedSave();
    }

    // ── Focus tracking ─────────────────────────────────────────────────────

    setFocusedLeaf(leafId: string | undefined): void {
        if (this._focusedLeafId !== leafId) {
            this._focusedLeafId = leafId;
            this._onFocusChange.fire(leafId);
        }
    }

    // ── Navigation ─────────────────────────────────────────────────────────

    /**
     * Get the adjacent leaf in a direction from the focused leaf.
     * Direction: 'left', 'right', 'up', 'down'
     */
    getAdjacentLeaf(tabId: string, fromLeafId: string, direction: 'left' | 'right' | 'up' | 'down'): LeafNode | null {
        const tab = this._layout.tabs.find(t => t.id === tabId);
        if (!tab) return null;

        // Collect all leaves with their bounding positions in normalized coords
        const leaves: Array<{ leaf: LeafNode; x: number; y: number; w: number; h: number }> = [];
        this.collectLeafBounds(tab.root, 0, 0, 1, 1, leaves);

        const from = leaves.find(l => l.leaf.id === fromLeafId);
        if (!from) return null;

        // Find the best candidate in the given direction
        let best: LeafNode | null = null;
        let bestDist = Infinity;

        const fromCx = from.x + from.w / 2;
        const fromCy = from.y + from.h / 2;

        for (const cand of leaves) {
            if (cand.leaf.id === fromLeafId) continue;

            const cx = cand.x + cand.w / 2;
            const cy = cand.y + cand.h / 2;

            let valid = false;
            let dist = 0;

            switch (direction) {
                case 'left':
                    valid = cx < fromCx;
                    dist = Math.abs(fromCx - cx) + Math.abs(fromCy - cy) * 0.5;
                    break;
                case 'right':
                    valid = cx > fromCx;
                    dist = Math.abs(cx - fromCx) + Math.abs(fromCy - cy) * 0.5;
                    break;
                case 'up':
                    valid = cy < fromCy;
                    dist = Math.abs(fromCy - cy) + Math.abs(fromCx - cx) * 0.5;
                    break;
                case 'down':
                    valid = cy > fromCy;
                    dist = Math.abs(cy - fromCy) + Math.abs(fromCx - cx) * 0.5;
                    break;
            }

            if (valid && dist < bestDist) {
                bestDist = dist;
                best = cand.leaf;
            }
        }

        return best;
    }

    /** Collect all leaf nodes with their normalized bounding boxes. */
    private collectLeafBounds(
        node: LayoutNode,
        x: number, y: number, w: number, h: number,
        out: Array<{ leaf: LeafNode; x: number; y: number; w: number; h: number }>,
    ): void {
        if (node.type === 'leaf') {
            out.push({ leaf: node, x, y, w, h });
            return;
        }

        let offset = 0;
        for (let i = 0; i < node.children.length; i++) {
            const size = node.sizes[i] || (1 / node.children.length);
            if (node.direction === 'horizontal') {
                // Horizontal split: children side by side
                this.collectLeafBounds(node.children[i], x + offset * w, y, size * w, h, out);
            } else {
                // Vertical split: children stacked
                this.collectLeafBounds(node.children[i], x, y + offset * h, w, size * h, out);
            }
            offset += size;
        }
    }

    // ── Utility ────────────────────────────────────────────────────────────

    /** Get all leaf nodes across all tabs. */
    getAllLeaves(): LeafNode[] {
        const leaves: LeafNode[] = [];
        for (const tab of this._layout.tabs) {
            for (const leaf of walkLeaves(tab.root)) {
                leaves.push(leaf);
            }
        }
        return leaves;
    }

    /** Get all leaf nodes in a specific tab. */
    getTabLeaves(tabId: string): LeafNode[] {
        const tab = this._layout.tabs.find(t => t.id === tabId);
        if (!tab) return [];
        return Array.from(walkLeaves(tab.root));
    }

    /** Find a leaf by its id in any tab. */
    findLeaf(leafId: string): { tab: TabLayout; leaf: LeafNode } | null {
        for (const tab of this._layout.tabs) {
            for (const leaf of walkLeaves(tab.root)) {
                if (leaf.id === leafId) {
                    return { tab, leaf };
                }
            }
        }
        return null;
    }

    /** Get the first editor leaf (for "primary" designation). */
    getFirstEditorLeaf(): LeafNode | undefined {
        for (const tab of this._layout.tabs) {
            for (const leaf of walkLeaves(tab.root)) {
                if (leaf.role === 'editor') return leaf;
            }
        }
        return undefined;
    }

    // ── Persistence ────────────────────────────────────────────────────────

    private restore(): WorkspaceLayout {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const layout = JSON.parse(stored) as WorkspaceLayout;
                if ((layout.version === 1 || layout.version === 2) && layout.tabs && layout.tabs.length > 0) {
                    // Migrate v1: 'editor' → 'neovim', 'widget' → 'neovim'
                    if (layout.version === 1) {
                        for (const tab of layout.tabs) {
                            migrateV1Roles(tab.root);
                        }
                        layout.version = 2;
                    }
                    // Regenerate instanceIds — PTYs are dead after page refresh
                    for (const tab of layout.tabs) {
                        regenerateInstanceIds(tab.root);
                    }
                    if (layout.activeTabIndex < 0 || layout.activeTabIndex >= layout.tabs.length) {
                        layout.activeTabIndex = 0;
                    }
                    return layout;
                }
            }
        } catch {
            // Corrupt data — use default
        }
        return defaultLayout();
    }

    save(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._layout));
        } catch {
            // localStorage full or blocked — ignore
        }
    }

    private debouncedSave(): void {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.save(), 300);
    }

    private fireAndSave(): void {
        this._onLayoutChange.fire(this._layout);
        this.debouncedSave();
    }
}
