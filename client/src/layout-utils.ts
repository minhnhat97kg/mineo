import type { IJsonModel } from 'flexlayout-react';
import { PANE_TITLES } from './panes/pane-types';

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

export function defaultJson(): IJsonModel {
    return {
        global: {
            tabEnableClose: true,
            tabEnableRename: false,
            tabSetEnableMaximize: true,
            tabSetMinWidth: 100,
            tabSetMinHeight: 50,
            splitterSize: 5,
        },
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
