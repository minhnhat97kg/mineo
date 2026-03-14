/**
 * Shared types for the tmux-like tiling layout system.
 */

/** UUID v4 string identifying a PTY instance (or stable widget key). */
export type PtyInstanceId = string;

/** What a pane renders. Must match a registered PaneDescriptor.role. */
export type PaneRole = 'neovim' | 'terminal' | 'monaco';

/** A leaf node in the layout tree — one pane. */
export interface LeafNode {
    type: 'leaf';
    id: string;
    role: PaneRole;
    instanceId: PtyInstanceId;
}

/** A split node containing two or more children arranged in a direction. */
export interface SplitNode {
    type: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    children: LayoutNode[];
    /** Relative sizes, e.g. [0.5, 0.5]. Must sum to ~1.0 and match children.length. */
    sizes: number[];
}

/** A node in the layout tree — either a leaf pane or a split container. */
export type LayoutNode = LeafNode | SplitNode;

/** Layout for a single tab — one root node (leaf or split). */
export interface TabLayout {
    id: string;
    label: string;
    root: LayoutNode;
}

/** Serializable workspace layout — the entire tiling state. */
export interface WorkspaceLayout {
    version: 1 | 2;
    activeTabIndex: number;
    tabs: TabLayout[];
}
