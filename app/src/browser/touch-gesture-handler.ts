// app/src/browser/touch-gesture-handler.ts
import { Terminal } from 'xterm';
import { Disposable, DisposableCollection } from '@theia/core';

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const SWIPE_THRESHOLD_PX = 10;   // minimum Y delta to count as a scroll swipe
const SCROLL_SENSITIVITY = 0.05; // lines per pixel of swipe

export class TouchGestureHandler implements Disposable {
    private readonly toDispose = new DisposableCollection();
    private touchStartY = 0;
    private touchStartX = 0;
    private initialPinchDistance = 0;
    private initialFontSize = 14;
    private isPinching = false;

    constructor(
        private readonly node: HTMLElement,
        private readonly term: Terminal,
    ) {
        this.attach();
    }

    private attach(): void {
        const onTouchStart = (e: TouchEvent) => this.handleTouchStart(e);
        const onTouchMove  = (e: TouchEvent) => this.handleTouchMove(e);
        const onTouchEnd   = (e: TouchEvent) => this.handleTouchEnd(e);

        this.node.addEventListener('touchstart', onTouchStart, { passive: false });
        this.node.addEventListener('touchmove',  onTouchMove,  { passive: false });
        this.node.addEventListener('touchend',   onTouchEnd,   { passive: false });

        this.toDispose.push(Disposable.create(() => {
            this.node.removeEventListener('touchstart', onTouchStart);
            this.node.removeEventListener('touchmove',  onTouchMove);
            this.node.removeEventListener('touchend',   onTouchEnd);
        }));
    }

    private handleTouchStart(e: TouchEvent): void {
        if (e.touches.length === 1) {
            this.isPinching = false;
            this.touchStartY = e.touches[0].clientY;
            this.touchStartX = e.touches[0].clientX;
        } else if (e.touches.length === 2) {
            this.isPinching = true;
            this.initialPinchDistance = this.getPinchDistance(e);
            this.initialFontSize = (this.term.options.fontSize as number) ?? 14;
            e.preventDefault(); // prevent browser zoom
        }
    }

    private handleTouchMove(e: TouchEvent): void {
        if (e.touches.length === 2 && this.isPinching) {
            e.preventDefault();
            const dist = this.getPinchDistance(e);
            const scale = dist / (this.initialPinchDistance || 1);
            const newSize = Math.round(this.initialFontSize * scale);
            const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, newSize));
            this.term.options.fontSize = clamped;
            return;
        }

        if (e.touches.length === 1 && !this.isPinching) {
            const deltaY = this.touchStartY - e.touches[0].clientY;
            if (Math.abs(deltaY) > SWIPE_THRESHOLD_PX) {
                e.preventDefault(); // prevent page scroll while swiping in terminal
                const lines = Math.round(deltaY * SCROLL_SENSITIVITY);
                if (lines !== 0) {
                    this.term.scrollLines(lines);
                    this.touchStartY = e.touches[0].clientY;
                }
            }
        }
    }

    private handleTouchEnd(e: TouchEvent): void {
        if (!this.isPinching && e.changedTouches.length === 1) {
            const dx = Math.abs(e.changedTouches[0].clientX - this.touchStartX);
            const dy = Math.abs(e.changedTouches[0].clientY - this.touchStartY);
            if (dx < 10 && dy < 10) {
                // It was a tap — focus the terminal
                this.term.focus();
            }
        }
        if (e.touches.length < 2) {
            this.isPinching = false;
        }
    }

    private getPinchDistance(e: TouchEvent): number {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    dispose(): void {
        this.toDispose.dispose();
    }
}
