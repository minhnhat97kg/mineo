import type { PaneRole } from '../pty-control-service';

export type ComponentType = PaneRole | 'explorer' | 'settings';

export const PANE_ICONS: Record<ComponentType, string> = {
    neovim:   'devicon-neovim-plain colored',
    terminal: 'devicon-bash-plain colored',
    explorer: 'devicon-filezilla-plain colored',
    settings: 'devicon-vscode-plain colored',
};

export const PANE_TITLES: Record<ComponentType, string> = {
    neovim:   'Neovim',
    terminal: 'Terminal',
    explorer: 'Explorer',
    settings: 'Settings',
};
