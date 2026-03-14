/**
 * terminal-pane — PaneDescriptor for the terminal pane.
 * Creates a NvimWidget in terminal role and spawns a shell PTY.
 */

import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { NvimWidget } from '../neovim-widget';
import { NvimWidgetFactory } from '../nvim-widget-factory';
import { PtyControlService } from '../pty-control-service';
import type { PaneDescriptor, PaneContext } from './index';

export const terminalPaneDescriptor: PaneDescriptor = {
    role: 'terminal',
    label: 'Terminal',
    icon: 'codicon codicon-terminal-bash',

    async create(ctx: PaneContext): Promise<Widget> {
        const factory = ctx.diContainer.get<NvimWidgetFactory>(NvimWidgetFactory);
        const ptyService = ctx.diContainer.get(PtyControlService);

        const widget = factory({ instanceId: ctx.instanceId, role: 'terminal' });

        const hash = window.location.hash.replace(/^#/, '');
        const cwd = hash.startsWith('/') ? hash : undefined;
        await ptyService.spawn(ctx.instanceId, 'terminal', 120, 30, cwd);
        widget.connectChannels();

        return widget;
    },

    destroy(widget: Widget, _instanceId: string): void {
        if (widget instanceof NvimWidget) {
            widget.dispose();
        }
    },
};
