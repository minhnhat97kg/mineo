/**
 * PaneRegistry — maps pane role strings to PaneDescriptor objects.
 * All pane type definitions live in app/src/browser/panes/ for easy management.
 */

import { injectable } from '@theia/core/shared/inversify';
import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { interfaces } from '@theia/core/shared/inversify';
import { LayoutTreeManager } from '../layout-tree-manager';

export interface PaneContext {
    instanceId: string;
    role: string;
    diContainer: interfaces.Container;
}

export interface PaneDescriptor {
    /** Unique key — must match LeafNode.role values. */
    role: string;
    /** Human-readable name shown in the pane type picker. */
    label: string;
    /** Codicon CSS class, e.g. 'codicon codicon-terminal'. */
    icon: string;
    /** If true, only one pane of this type is allowed per tab. */
    singleton?: boolean;
    /** Create the widget for this pane. Called by TilingContainer. */
    create(ctx: PaneContext): Promise<Widget>;
    /** Cleanup when pane is closed. Kill PTY, dispose resources, etc. */
    destroy?(widget: Widget, instanceId: string): void;
}

@injectable()
export class PaneRegistry {
    private readonly descriptors = new Map<string, PaneDescriptor>();

    register(descriptor: PaneDescriptor): void {
        this.descriptors.set(descriptor.role, descriptor);
    }

    get(role: string): PaneDescriptor | undefined {
        return this.descriptors.get(role);
    }

    getAll(): PaneDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    /**
     * Returns true if a pane of the given role can be added to the given tab.
     * Enforces the singleton constraint.
     */
    canAdd(tabId: string, role: string, layoutTreeManager: LayoutTreeManager): boolean {
        const descriptor = this.descriptors.get(role);
        if (!descriptor?.singleton) return true;
        const leaves = layoutTreeManager.getTabLeaves(tabId);
        return !leaves.some(l => l.role === role);
    }
}
