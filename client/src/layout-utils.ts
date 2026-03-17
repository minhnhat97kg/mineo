import type { IJsonModel } from 'flexlayout-react';
import { PANE_TITLES } from './panes/pane-types';
import type { WindowInfo } from './pty-control-service';

export function uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export function cwd(): string | undefined {
    const h = location.hash.replace(/^#/, '');
    return h.startsWith('/') ? h : undefined;
}

const LAYOUT_GLOBAL = {
    tabEnableClose: true,
    tabEnableRename: false,
    tabSetEnableMaximize: true,
    tabSetMinWidth: 100,
    tabSetMinHeight: 50,
    splitterSize: 5,
};

export function defaultJson(): IJsonModel {
    return {
        global: LAYOUT_GLOBAL,
        layout: {
            type: 'row',
            children: [
                {
                    type: 'tabset',
                    weight: 20,
                    children: [
                        {
                            type: 'tab',
                            name: PANE_TITLES.explorer,
                            component: 'explorer',
                            id: uuid(),
                        },
                    ],
                },
                {
                    type: 'tabset',
                    weight: 80,
                    active: true,
                    children: [
                        {
                            type: 'tab',
                            name: PANE_TITLES.neovim,
                            component: 'neovim',
                            config: { instanceId: uuid() },
                        },
                    ],
                },
            ],
        },
    };
}

/**
 * Build a flat layout from existing tmux windows.
 * All windows go into a single tabset with an explorer on the left.
 */
export function buildFromWindows(windows: WindowInfo[]): IJsonModel {
    const tabs = windows.map(w => ({
        type: 'tab' as const,
        name: w.role === 'neovim' ? PANE_TITLES.neovim : PANE_TITLES.terminal,
        component: w.role,
        config: { instanceId: w.id },
        id: w.id,
    }));

    return {
        global: LAYOUT_GLOBAL,
        layout: {
            type: 'row',
            children: [
                {
                    type: 'tabset',
                    weight: 20,
                    children: [
                        {
                            type: 'tab',
                            name: PANE_TITLES.explorer,
                            component: 'explorer',
                            id: uuid(),
                        },
                    ],
                },
                {
                    type: 'tabset',
                    weight: 80,
                    active: true,
                    children: tabs.length > 0 ? tabs : [
                        {
                            type: 'tab',
                            name: PANE_TITLES.neovim,
                            component: 'neovim',
                            config: { instanceId: uuid() },
                        },
                    ],
                },
            ],
        },
    };
}

/**
 * Validate a saved layout against live tmux windows.
 * Removes tabs whose instance IDs no longer exist in tmux.
 * Returns the cleaned layout, or null if it's too broken to use.
 */
export function validateLayout(
    saved: IJsonModel,
    windows: WindowInfo[],
): IJsonModel | null {
    const windowIds = new Set(windows.map(w => w.id));

    // Deep clone to avoid mutating the input
    const layout = JSON.parse(JSON.stringify(saved)) as IJsonModel;

    // Recursively filter children, removing pty tabs whose IDs are gone
    function filterChildren(node: Record<string, unknown>): boolean {
        if (!node.children || !Array.isArray(node.children)) return true;

        node.children = (node.children as Record<string, unknown>[]).filter(child => {
            const component = child.component as string | undefined;
            const config = child.config as { instanceId?: string } | undefined;

            // If it's a pty tab, check if the window still exists
            if ((component === 'neovim' || component === 'terminal') && config?.instanceId) {
                return windowIds.has(config.instanceId);
            }

            // Recurse into tabsets/rows
            if (child.children) {
                const keep = filterChildren(child);
                // Remove empty tabsets
                if (child.type === 'tabset' && (child.children as unknown[]).length === 0) {
                    return false;
                }
                return keep;
            }

            // Keep non-pty tabs (explorer, settings, plugins)
            return true;
        });

        return (node.children as unknown[]).length > 0;
    }

    if (layout.layout) {
        filterChildren(layout.layout as unknown as Record<string, unknown>);
    }

    return layout;
}
