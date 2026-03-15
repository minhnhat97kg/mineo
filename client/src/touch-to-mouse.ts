/**
 * Enables drag-and-drop tab reordering on touch devices for flexlayout-react.
 *
 * flexlayout uses the HTML5 Drag & Drop API (dragstart / dragover / drop).
 * Mobile browsers don't fire these from touch, so we translate:
 *   touchstart → dragstart  (on a .flexlayout__tab_button)
 *   touchmove  → dragover   (on whatever element is under the finger)
 *   touchend   → drop + dragend
 *
 * A short hold (150 ms) is required before drag begins, so normal taps
 * still register as clicks and don't accidentally start a drag.
 *
 * xterm panes are excluded — they handle their own touch input.
 */

const TAB_SELECTOR = '.flexlayout__tab_button';
const HOLD_MS = 150;

function isXterm(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.xterm') !== null;
}

function makeDataTransfer(): DataTransfer {
    // DataTransfer can't be constructed directly; use a minimal stand-in
    // that satisfies flexlayout's dragstart handler (it only calls setData).
    const store: Record<string, string> = {};
    return {
        setData: (k: string, v: string) => { store[k] = v; },
        getData: (k: string) => store[k] ?? '',
        clearData: () => { for (const k in store) delete store[k]; },
        setDragImage: () => {},
        dropEffect: 'move',
        effectAllowed: 'all',
        files: new FileList(),
        items: [] as unknown as DataTransferItemList,
        types: [],
    } as unknown as DataTransfer;
}

function fireEvent(type: string, target: Element, touch: Touch, dt: DataTransfer): boolean {
    const evt = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
    });
    return target.dispatchEvent(evt);
}

export function installTouchToMouse(): void {
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let dragging = false;
    let activeTouchId: number | null = null;
    let dragSource: Element | null = null;
    let lastOver: Element | null = null;
    let dt: DataTransfer | null = null;

    const cancel = () => {
        clearTimeout(holdTimer);
        if (dragging && dragSource && dt) {
            fireEvent('dragend', dragSource, { clientX: 0, clientY: 0, screenX: 0, screenY: 0 } as Touch, dt);
        }
        dragging = false;
        activeTouchId = null;
        dragSource = null;
        lastOver = null;
        dt = null;
    };

    document.addEventListener('touchstart', (e: TouchEvent) => {
        if (isXterm(e.target)) return;
        if (activeTouchId !== null) return;

        const touch = e.changedTouches[0];
        const tab = (e.target as Element).closest(TAB_SELECTOR);
        if (!tab) return;

        activeTouchId = touch.identifier;
        dragSource = tab;
        dt = makeDataTransfer();

        holdTimer = setTimeout(() => {
            if (!dragSource || !dt) return;
            // Prevent the browser from scrolling during drag
            dragging = true;
            fireEvent('dragstart', dragSource, touch, dt);
        }, HOLD_MS);
    }, { capture: true, passive: true });

    document.addEventListener('touchmove', (e: TouchEvent) => {
        if (activeTouchId === null || !dragging) return;
        const touch = [...e.changedTouches].find(t => t.identifier === activeTouchId);
        if (!touch || !dt) return;

        // Find the element currently under the finger (not the dragged element)
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!el) return;

        if (lastOver && lastOver !== el) {
            fireEvent('dragleave', lastOver, touch, dt);
        }
        fireEvent('dragover', el, touch, dt);
        lastOver = el;
    }, { capture: true, passive: false });

    document.addEventListener('touchend', (e: TouchEvent) => {
        clearTimeout(holdTimer);
        if (activeTouchId === null) return;
        const touch = [...e.changedTouches].find(t => t.identifier === activeTouchId);
        activeTouchId = null;

        if (!dragging || !touch || !dt) {
            dragging = false;
            dragSource = null;
            dt = null;
            return;
        }

        const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
        if (dropTarget) fireEvent('drop', dropTarget, touch, dt);
        if (dragSource) fireEvent('dragend', dragSource, touch, dt);

        dragging = false;
        dragSource = null;
        lastOver = null;
        dt = null;
    }, { capture: true, passive: true });

    document.addEventListener('touchcancel', () => cancel(), { capture: true, passive: true });
}
