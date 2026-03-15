import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoldenLayout, ComponentContainer, LayoutConfig } from 'golden-layout';
import { XtermPane } from './XtermPane';
import { ptyControlService, PaneRole } from './pty-control-service';

const STORAGE_KEY = 'mineo.layout';

function uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function cwd(): string | undefined {
    const h = location.hash.replace(/^#/, '');
    return h.startsWith('/') ? h : undefined;
}

function defaultLayout(): LayoutConfig {
    return {
        root: {
            type: 'stack',
            content: [{
                type: 'component',
                componentType: 'neovim',
                componentState: { instanceId: uuid(), role: 'neovim' as PaneRole },
                title: 'Neovim',
            }],
        },
    };
}

export interface LayoutContainerHandle {
    addPane(role: PaneRole): void;
}

export const LayoutContainer = forwardRef<LayoutContainerHandle>(function LayoutContainer(_, ref) {
    const divRef = useRef<HTMLDivElement>(null);
    const glRef = useRef<GoldenLayout | null>(null);

    useImperativeHandle(ref, () => ({
        addPane(role: PaneRole) {
            glRef.current?.addComponent(role, { instanceId: uuid(), role }, role === 'terminal' ? 'Terminal' : 'Neovim');
        },
    }));

    useEffect(() => {
        const container = divRef.current!;
        const gl = new GoldenLayout(container);
        glRef.current = gl;

        const mount = (glc: ComponentContainer, state: unknown) => {
            const { instanceId, role } = state as { instanceId: string; role: PaneRole };
            ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: cwd() });

            const root = createRoot(glc.element);
            root.render(<XtermPane instanceId={instanceId} role={role} />);

            glc.on('destroy', () => {
                ptyControlService.kill(instanceId);
                root.unmount();
            });
        };

        gl.registerComponentFactoryFunction('neovim', mount);
        gl.registerComponentFactoryFunction('terminal', mount);

        const saved = (() => {
            try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) as LayoutConfig : null; } catch { return null; }
        })();

        gl.init();
        try { gl.loadLayout(saved ?? defaultLayout()); }
        catch { gl.loadLayout(defaultLayout()); }

        gl.on('stateChanged', () => {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gl.saveLayout())); } catch { /* ignore */ }
        });

        const onResize = () => gl.updateSize(container.offsetWidth, container.offsetHeight);
        window.addEventListener('resize', onResize);

        return () => {
            window.removeEventListener('resize', onResize);
            gl.destroy();
            glRef.current = null;
        };
    }, []);

    return <div ref={divRef} style={{ flex: 1, minHeight: 0 }} />;
});
