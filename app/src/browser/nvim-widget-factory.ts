/**
 * NvimWidgetFactory — InversifyJS factory for creating NvimWidget instances
 * with unique instanceIds and roles via child containers.
 *
 * Usage:
 *   const factory = container.get(NvimWidgetFactory);
 *   const widget = factory({ role: 'neovim' });
 *   await widget.requestSpawn();
 */

import { interfaces } from '@theia/core/shared/inversify';
import { NvimWidget } from './neovim-widget';
import type { PtyInstanceId, PaneRole } from '../common/layout-types';

export interface NvimWidgetFactoryOptions {
    instanceId?: PtyInstanceId;
    role: PaneRole;
    existing?: NvimWidget;
}

export type NvimWidgetFactory = (options: NvimWidgetFactoryOptions) => NvimWidget;

export const NvimWidgetFactory = Symbol('NvimWidgetFactory');

/** Generate a UUID v4 (browser-compatible). */
function generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Bind the NvimWidgetFactory into an InversifyJS container.
 */
export function bindNvimWidgetFactory(bind: interfaces.Bind): void {
    bind(NvimWidgetFactory).toFactory(context => {
        return (options: NvimWidgetFactoryOptions): NvimWidget => {
            if (options.existing) return options.existing;
            
            const child = context.container.createChild();
            const instanceId = options.instanceId || generateId();
            child.bind('PtyInstanceId').toConstantValue(instanceId);
            child.bind('PaneRole').toConstantValue(options.role);
            child.bind(NvimWidget).toSelf().inTransientScope();
            return child.get(NvimWidget);
        };
    });
}
