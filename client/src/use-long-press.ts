import { useEffect, useRef } from 'react';

const LONG_PRESS_MS    = 650;
const LONG_PRESS_MOVE  = 8; // px — cancel if finger moves more than this

/**
 * Attaches a touch long-press detector to the element referenced by `elRef`.
 *
 * Uses non-passive native listeners so we can call preventDefault() and
 * suppress the browser's built-in long-press actions (text-selection popup,
 * iOS "Copy / Look Up / Share" sheet, etc.).
 *
 * The callback receives the (clientX, clientY) of the original touchstart.
 * Re-attaches only when elRef.current changes; callback is kept stable via ref.
 */
export function useLongPress(
    elRef: React.RefObject<HTMLElement | null>,
    callback: (clientX: number, clientY: number) => void,
) {
    const cbRef = useRef(callback);
    cbRef.current = callback;

    useEffect(() => {
        const el = elRef.current;
        if (!el) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        let startX = 0;
        let startY = 0;
        let fired = false;

        const onTouchStart = (e: TouchEvent) => {
            const t = e.touches[0];
            startX = t.clientX;
            startY = t.clientY;
            fired  = false;
            timer  = setTimeout(() => {
                fired = true;
                e.preventDefault(); // suppress browser long-press UI
                cbRef.current(t.clientX, t.clientY);
            }, LONG_PRESS_MS);
        };

        const onTouchMove = (e: TouchEvent) => {
            const t = e.changedTouches[0];
            if (Math.abs(t.clientX - startX) > LONG_PRESS_MOVE ||
                Math.abs(t.clientY - startY) > LONG_PRESS_MOVE) {
                clearTimeout(timer);
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            clearTimeout(timer);
            // Eat the touchend so it doesn't also trigger a tap/click
            if (fired) e.preventDefault();
        };

        const onTouchCancel = () => clearTimeout(timer);

        el.addEventListener('touchstart',  onTouchStart,  { passive: false });
        el.addEventListener('touchmove',   onTouchMove,   { passive: true  });
        el.addEventListener('touchend',    onTouchEnd,    { passive: false });
        el.addEventListener('touchcancel', onTouchCancel, { passive: true  });

        return () => {
            clearTimeout(timer);
            el.removeEventListener('touchstart',  onTouchStart);
            el.removeEventListener('touchmove',   onTouchMove);
            el.removeEventListener('touchend',    onTouchEnd);
            el.removeEventListener('touchcancel', onTouchCancel);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [elRef]);
}
