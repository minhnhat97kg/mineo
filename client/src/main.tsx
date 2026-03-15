import 'flexlayout-react/style/dark.css';
import 'xterm/css/xterm.css';
import 'devicon/devicon.min.css';
import './style/main.css';
import './style/explorer.css';
import './style/menubar.css';
import './style/settings.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installTouchToMouse } from './touch-to-mouse';

const rootEl = document.getElementById('mineo-root')!;
document.addEventListener('contextmenu', e => e.preventDefault());

// ── Touch scroll ─────────────────────────────────────────────────────────
// iOS/iPadOS blocks page bounce but must allow scroll inside:
//   - .fe-root / .sp-root  → native overflow-y: auto, works with passive touch
//   - .xterm               → no native touch scroll; translate touchmove → wheel
let xtermTouchStartY = 0;
document.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length === 1) xtermTouchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchmove', (e: TouchEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) { e.preventDefault(); return; }

    // Native-scrollable panes — let the browser handle it
    if (target.closest('.fe-root') || target.closest('.fe-tree') || target.closest('.sp-root')) return;

    // xterm — translate to wheel event so scrollback works
    const xtermEl = target.closest('.xterm');
    if (xtermEl) {
        const touch = e.touches[0];
        const dy = xtermTouchStartY - touch.clientY;
        xtermTouchStartY = touch.clientY;
        const viewport = xtermEl.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true,
                deltaY: dy * 2,
                deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            }));
        }
        e.preventDefault();
        return;
    }

    // Everything else — block page bounce
    e.preventDefault();
}, { passive: false });

installTouchToMouse();
createRoot(rootEl).render(<App />);
