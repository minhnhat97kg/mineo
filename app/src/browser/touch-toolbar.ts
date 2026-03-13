import { Disposable, DisposableCollection } from '@theia/core';

export interface TouchToolbarOptions {
    /** Called when the toolbar wants to send a key sequence to the terminal */
    sendKey: (data: string) => void;
}

export class TouchToolbar implements Disposable {
    private readonly toDispose = new DisposableCollection();
    private fab!: HTMLElement;
    private panel!: HTMLElement;
    private ctrlActive = false;
    private panelOpen = false;

    // Drag state
    private dragging = false;
    private dragOffsetX = 0;
    private dragOffsetY = 0;

    constructor(
        private readonly container: HTMLElement,
        private readonly opts: TouchToolbarOptions,
    ) {
        this.build();
        this.toDispose.push(Disposable.create(() => this.teardown()));
    }

    private build(): void {
        // ── FAB ──────────────────────────────────────────────────────────────
        this.fab = document.createElement('div');
        this.fab.className = 'nvim-touch-fab';
        this.fab.setAttribute('aria-label', 'Toggle keyboard toolbar');
        this.fab.textContent = '⌨';

        // ── Panel ─────────────────────────────────────────────────────────────
        this.panel = document.createElement('div');
        this.panel.className = 'nvim-touch-panel nvim-touch-panel--hidden';

        const escBtn = this.makeButton('ESC',  () => this.sendKey('\x1b'));
        const ctrlBtn = this.makeButton('CTRL', () => this.toggleCtrl(ctrlBtn));
        this.panel.appendChild(escBtn);
        this.panel.appendChild(ctrlBtn);

        this.container.appendChild(this.fab);
        this.container.appendChild(this.panel);

        // ── FAB: tap to toggle, drag to reposition ────────────────────────────
        let dragMoved = false;
        let pointerDownTime = 0;

        let dragging = false;

        const onPointerDown = (e: PointerEvent) => {
            dragging = false;
            dragMoved = false;
            pointerDownTime = Date.now();
            this.dragging = false;
            this.dragOffsetX = e.clientX - this.fab.getBoundingClientRect().left;
            this.dragOffsetY = e.clientY - this.fab.getBoundingClientRect().top;
            this.fab.setPointerCapture(e.pointerId);
        };
        const onPointerMove = (e: PointerEvent) => {
            if (!this.fab.hasPointerCapture(e.pointerId)) return;
            const moved =
                Math.abs(e.clientX - (this.fab.getBoundingClientRect().left + this.dragOffsetX)) > 5 ||
                Math.abs(e.clientY - (this.fab.getBoundingClientRect().top  + this.dragOffsetY)) > 5;
            if (moved || dragging) {
                dragging = true;
                dragMoved = true;
                this.dragging = true;
                const rect = this.container.getBoundingClientRect();
                const x = e.clientX - rect.left - this.dragOffsetX;
                const y = e.clientY - rect.top  - this.dragOffsetY;
                // Clamp within container
                const maxX = rect.width  - this.fab.offsetWidth;
                const maxY = rect.height - this.fab.offsetHeight;
                this.fab.style.left = Math.max(0, Math.min(maxX, x)) + 'px';
                this.fab.style.top  = Math.max(0, Math.min(maxY, y)) + 'px';
                this.fab.style.right  = 'auto';
                this.fab.style.bottom = 'auto';
                // Move panel near FAB
                this.positionPanel();
            }
        };

        const onPointerUp = (_e: PointerEvent) => {
            if (!dragMoved) {
                // It was a tap — toggle panel
                this.togglePanel();
            }
            dragging = false;
            this.dragging = false;
        };

        this.fab.addEventListener('pointerdown', onPointerDown);
        this.fab.addEventListener('pointermove', onPointerMove);
        this.fab.addEventListener('pointerup',   onPointerUp);

        this.toDispose.push(Disposable.create(() => {
            this.fab.removeEventListener('pointerdown', onPointerDown);
            this.fab.removeEventListener('pointermove', onPointerMove);
            this.fab.removeEventListener('pointerup',   onPointerUp);
        }));
    }

    private makeButton(label: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'nvim-touch-btn';
        btn.textContent = label;
        btn.addEventListener('pointerdown', e => {
            e.preventDefault(); // prevent focus stealing from terminal
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    private togglePanel(): void {
        this.panelOpen = !this.panelOpen;
        this.panel.classList.toggle('nvim-touch-panel--hidden', !this.panelOpen);
        if (this.panelOpen) this.positionPanel();
    }

    private positionPanel(): void {
        const fabRect = this.fab.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();
        // Place panel above the FAB
        const top  = fabRect.top  - containerRect.top  - 48;
        const left = fabRect.left - containerRect.left;
        this.panel.style.top  = Math.max(0, top)  + 'px';
        this.panel.style.left = Math.max(0, left) + 'px';
    }

    private toggleCtrl(btn: HTMLElement): void {
        this.ctrlActive = !this.ctrlActive;
        btn.classList.toggle('nvim-touch-btn--active', this.ctrlActive);
    }

    private sendKey(data: string): void {
        if (this.ctrlActive && data !== '\x1b') {
            // Encode Ctrl+key: take the key char and AND with 0x1f
            const char = data[0];
            const ctrlCode = String.fromCharCode(char.charCodeAt(0) & 0x1f);
            this.opts.sendKey(ctrlCode);
        } else {
            this.opts.sendKey(data);
        }
        // Always deactivate sticky CTRL after any key (including ESC)
        if (this.ctrlActive) {
            this.ctrlActive = false;
            this.panel.querySelector<HTMLElement>('.nvim-touch-btn--active')
                ?.classList.remove('nvim-touch-btn--active');
        }
    }

    private teardown(): void {
        this.fab.remove();
        this.panel.remove();
    }

    dispose(): void {
        this.toDispose.dispose();
    }
}
