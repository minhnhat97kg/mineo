import {
    useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState,
} from 'react';
import { Actions, Layout, Model, TabNode, Action } from 'flexlayout-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { FileExplorer } from './FileExplorer';
import { SettingsPanel } from './SettingsPanel';
import { settingsStore } from './settings-store';
import { getTheme, applyThemeCSS } from './themes';
import { PtyPane } from './panes/PtyPane';
import { ComponentType, PANE_ICONS, PANE_TITLES } from './panes/pane-types';
import { uuid, defaultJson, buildFromWindows, validateLayout } from './layout-utils';
import { ptyControlService } from './pty-control-service';
import { getPlugin } from './plugins/registry';
import './plugins/index'; // side-effect: registers all plugins

export interface LayoutContainerHandle {
    addPane(role: ComponentType): void;
}

// ─── LayoutContainer ─────────────────────────────────────────────────────────

export const LayoutContainer = forwardRef<LayoutContainerHandle, { keyboardLocked: boolean }>(
function LayoutContainer({ keyboardLocked }, ref) {
    const layoutRef = useRef<Layout>(null);
    const lastFocusedNvimRef = useRef<string | null>(null);
    const termMapRef = useRef<Map<string, { term: Terminal; fitAddon: FitAddon }>>(new Map());
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [model, setModel] = useState<Model | null>(null);

    // On mount: restore layout from server or build from existing tmux windows
    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                // 1. Try to load saved layout from server
                const layoutRes = await fetch('/api/session/layout');
                const { layout: savedLayout } = await layoutRes.json();

                // 2. Get current tmux windows
                const windows = await ptyControlService.list();

                if (cancelled) return;

                if (savedLayout && windows.length > 0) {
                    // Saved layout exists AND tmux windows exist → restore & validate
                    const validated = validateLayout(savedLayout, windows);
                    if (validated) {
                        setModel(Model.fromJson(validated));
                        return;
                    }
                }

                if (windows.length > 0) {
                    // Tmux windows exist but no saved layout → build flat tabs
                    setModel(Model.fromJson(buildFromWindows(windows)));
                    return;
                }

                // Fresh start — use default layout (new tmux windows will be created)
                setModel(Model.fromJson(defaultJson()));
            } catch {
                // On any error, fall back to default
                if (!cancelled) {
                    setModel(Model.fromJson(defaultJson()));
                }
            }
        }

        init();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        applyThemeCSS(getTheme(settingsStore.get().theme));
        const unsub = settingsStore.subscribe(s => {
            applyThemeCSS(getTheme(s.theme));
        });
        return unsub;
    }, []);

    // Persist layout to server (debounced)
    const persistLayout = useCallback(() => {
        if (!model) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            fetch('/api/session/layout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layout: model.toJson() }),
            }).catch(() => {});
        }, 500);
    }, [model]);

    const openFileInNvim = useCallback((filePath: string) => {
        const instanceId = lastFocusedNvimRef.current;
        const params = new URLSearchParams({ file: filePath });
        if (instanceId) params.set('instanceId', instanceId);
        fetch(`/api/nvim-open?${params}`).catch(() => {});
    }, []);

    const addPane = useCallback((role: ComponentType) => {
        const id = uuid();
        let title: string;
        if (role.startsWith('plugin:')) {
            title = getPlugin(role.slice(7))?.title ?? role.slice(7);
        } else {
            title = PANE_TITLES[role as keyof typeof PANE_TITLES];
        }
        layoutRef.current?.addTabToActiveTabSet({
            type: 'tab',
            name: title,
            component: role,
            config: (role === 'neovim' || role === 'terminal') ? { instanceId: id } : undefined,
            id,
        });
    }, []);

    useImperativeHandle(ref, () => ({ addPane }));

    // Handle tab close → kill the tmux window
    const onAction = useCallback((action: Action) => {
        if (action.type === Actions.DELETE_TAB && model) {
            const node = model.getNodeById(action.data.node);
            if (node && node instanceof TabNode) {
                const config = node.getConfig() as { instanceId?: string } | undefined;
                const component = node.getComponent();
                if ((component === 'neovim' || component === 'terminal') && config?.instanceId) {
                    ptyControlService.kill(config.instanceId);
                }
            }
        }
        return action; // allow default handling
    }, [model]);

    const factory = useCallback((node: TabNode) => {
        const component = node.getComponent() as ComponentType;
        const config = node.getConfig() as { instanceId?: string } | undefined;

        if (component === 'neovim' || component === 'terminal') {
            const instanceId = config?.instanceId ?? node.getId();
            return (
                <PtyPane
                    instanceId={instanceId}
                    role={component}
                    termMapRef={termMapRef}
                    lastFocusedNvimRef={lastFocusedNvimRef}
                    keyboardLocked={keyboardLocked}
                />
            );
        }
        if (component === 'explorer') {
            return <FileExplorer onOpenFile={openFileInNvim} />;
        }
        if (component === 'settings') {
            return <SettingsPanel />;
        }
        if (component.startsWith('plugin:')) {
            const pluginId = component.slice(7);
            const def = getPlugin(pluginId);
            if (def) {
                const PluginComponent = def.component;
                return <PluginComponent onOpenFile={openFileInNvim} />;
            }
            return (
                <div style={{ padding: 16, color: '#f55', fontFamily: 'monospace' }}>
                    Plugin not found: "{pluginId}"
                </div>
            );
        }
        return null;
    }, [openFileInNvim, keyboardLocked]);

    const onRenderTab = useCallback((node: TabNode, renderValues: { leading: React.ReactNode }) => {
        const component = node.getComponent() as ComponentType;
        let iconClass: string | undefined;
        if (component.startsWith('plugin:')) {
            iconClass = getPlugin(component.slice(7))?.iconClass;
        } else {
            iconClass = PANE_ICONS[component as keyof typeof PANE_ICONS];
        }
        if (iconClass) {
            renderValues.leading = <i className={iconClass} style={{ marginRight: 4, fontSize: 13 }} />;
        }
    }, []);

    // Don't render until model is loaded
    if (!model) {
        return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
                Loading...
            </div>
        );
    }

    return (
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <Layout
                ref={layoutRef}
                model={model}
                factory={factory}
                onAction={onAction}
                onModelChange={persistLayout}
                onRenderTab={onRenderTab}
                icons={{
                    close: (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                            <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                        </svg>
                    ),
                    maximize: (
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <polyline points="1,4 1,1 4,1" /><line x1="1" y1="1" x2="5" y2="5" />
                            <polyline points="10,7 10,10 7,10" /><line x1="10" y1="10" x2="6" y2="6" />
                        </svg>
                    ),
                    restore: (
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <polyline points="7,1 10,1 10,4" /><line x1="6" y1="5" x2="10" y2="1" />
                            <polyline points="4,10 1,10 1,7" /><line x1="5" y1="6" x2="1" y2="10" />
                        </svg>
                    ),
                }}
            />
        </div>
    );
});
