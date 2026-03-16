import type { ComponentType as ReactComponentType } from 'react';

// Props every plugin pane receives from the layout engine.
export interface PluginPaneProps {
    /** Open a workspace file in the active Neovim instance. */
    onOpenFile: (path: string) => void;
}

// Everything needed to register a plugin pane.
export interface PluginDefinition {
    /** Unique plugin id, e.g. "git-log". Used as the pane component key. */
    id: string;
    /** Tab bar title. */
    title: string;
    /**
     * Icon to show in the tab bar.
     * Can be a devicon CSS class (e.g. "devicon-git-plain colored")
     * or any custom CSS class you define.
     * Pass an empty string to show no icon.
     */
    iconClass: string;
    /** The React component rendered inside the pane. */
    component: ReactComponentType<PluginPaneProps>;
}

// ── Registry singleton ────────────────────────────────────────────────────────

const _plugins = new Map<string, PluginDefinition>();

/**
 * Register a plugin. Call this at module load-time (e.g. in plugins/index.ts).
 * Duplicate ids overwrite the previous registration with a warning.
 */
export function registerPlugin(def: PluginDefinition): void {
    if (_plugins.has(def.id)) {
        console.warn(`[mineo-plugins] overwriting plugin "${def.id}"`);
    }
    _plugins.set(def.id, def);
}

/** Retrieve a plugin by id. Returns undefined if not registered. */
export function getPlugin(id: string): PluginDefinition | undefined {
    return _plugins.get(id);
}

/** All registered plugins, in registration order. */
export function getAllPlugins(): PluginDefinition[] {
    return [..._plugins.values()];
}
