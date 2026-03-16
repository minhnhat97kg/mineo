import type { PaneRole } from '../pty-control-service';

// Built-in pane types (fixed set)
export type BuiltinType = PaneRole | 'explorer' | 'settings';

// Full component type: built-ins + any registered plugin (prefix "plugin:")
export type ComponentType = BuiltinType | `plugin:${string}`;

export const PANE_ICONS: Record<BuiltinType, string> = {
    neovim:   'devicon-neovim-plain colored',
    terminal: 'devicon-bash-plain colored',
    explorer: 'devicon-filezilla-plain colored',
    settings: 'devicon-vscode-plain colored',
};

export const PANE_TITLES: Record<BuiltinType, string> = {
    neovim:   'Neovim',
    terminal: 'Terminal',
    explorer: 'Explorer',
    settings: 'Settings',
};
