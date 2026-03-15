import { GoldenLayout, ComponentContainer, LayoutConfig } from 'golden-layout';
import { NvimWidget } from './nvim-widget';
import { ptyControlService, PaneRole } from './pty-control-service';

const STORAGE_KEY = 'mineo.layout';
const pool = new Map<string, NvimWidget>();

function uuid(): string { return crypto.randomUUID(); }
function cwd(): string | undefined { const h = location.hash.replace(/^#/, ''); return h.startsWith('/') ? h : undefined; }

function getOrCreate(instanceId: string, role: PaneRole): NvimWidget {
    let w = pool.get(instanceId);
    if (!w) {
        w = new NvimWidget(instanceId, role);
        pool.set(instanceId, w);
        ptyControlService.spawn({ instanceId, role, cols: 120, rows: 30, cwd: cwd() });
        w.connectChannels();
        w.onExit(() => pool.delete(instanceId));
    }
    return w;
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

export class LayoutManager {
    private gl: GoldenLayout;
    private container: HTMLElement;

    constructor(container: HTMLElement) {
        this.container = container;
        this.gl = new GoldenLayout(container);

        const mount = (glc: ComponentContainer, state: unknown) => {
            const { instanceId, role } = state as { instanceId: string; role: PaneRole };
            const w = getOrCreate(instanceId, role);
            glc.element.appendChild(w.element);
            w.attach();
            glc.on('resize', () => w.fitAndResize());
            glc.on('shown', () => { w.attach(); w.fitAndResize(); });
            glc.on('destroy', () => { pool.delete(instanceId); ptyControlService.kill(instanceId); w.dispose(); });
        };

        this.gl.registerComponentFactoryFunction('neovim', mount);
        this.gl.registerComponentFactoryFunction('terminal', mount);

        const saved = this.load();
        try { this.gl.loadLayout(saved ?? defaultLayout()); }
        catch { this.gl.loadLayout(defaultLayout()); }

        this.gl.on('stateChanged', () => this.save());
        window.addEventListener('resize', () =>
            this.gl.updateSize(this.container.offsetWidth, this.container.offsetHeight));
    }

    addPane(role: PaneRole = 'neovim'): void {
        this.gl.addComponent(role, { instanceId: uuid(), role }, role === 'terminal' ? 'Terminal' : 'Neovim');
    }

    private save(): void {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.gl.saveLayout())); } catch { /* ignore */ }
    }

    private load(): LayoutConfig | null {
        try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
    }
}
