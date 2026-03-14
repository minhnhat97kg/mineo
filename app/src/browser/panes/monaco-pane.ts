/**
 * monaco-pane — PaneDescriptor for the Monaco editor pane.
 * Creates a Theia EditorWidget via EditorManager.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { EditorManager } from '@theia/editor/lib/browser';
import URI from '@theia/core/lib/common/uri';
import type { PaneDescriptor, PaneContext } from './index';

export const monacoPaneDescriptor: PaneDescriptor = {
    role: 'monaco',
    label: 'Monaco Editor',
    icon: 'codicon codicon-edit',

    async create(ctx: PaneContext): Promise<Widget> {
        const editorManager = ctx.diContainer.get(EditorManager);

        // Open an untitled file in monaco — uses instanceId as unique URI segment
        const uri = new URI(`untitled:///${ctx.instanceId}`);
        const editorWidget = await editorManager.getOrCreateByUri(uri);

        return editorWidget;
    },

    destroy(widget: Widget, _instanceId: string): void {
        widget.dispose();
    },
};
