/**
 * neovim-pane — PaneDescriptor for the Neovim editor pane.
 * Creates a NvimWidget and spawns a neovim PTY via PtyControlService.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { NvimWidget } from '../neovim-widget';
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
import type { PaneDescriptor, PaneContext } from './index';

export const neovimPaneDescriptor: PaneDescriptor = {
    role: 'neovim',
    label: 'Neovim Editor',
    icon: 'codicon codicon-terminal',

    async create(ctx: PaneContext): Promise<Widget> {
        const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
        const ptyService = ctx.diContainer.get(PtyControlService);

        const widget = factory({ instanceId: ctx.instanceId, role: 'neovim' });

        const hash = window.location.hash.replace(/^#/, '');
        const cwd = hash.startsWith('/') ? hash : undefined;
        await ptyService.spawn(ctx.instanceId, 'neovim', 120, 30, cwd);
        widget.connectChannels();

        return widget;
    },

    destroy(widget: Widget, _instanceId: string): void {
        if (widget instanceof NvimWidget) {
            widget.dispose();
        }
    },
};
