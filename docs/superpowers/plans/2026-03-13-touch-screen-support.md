# Touch Screen Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add touch screen support to the Mineo Neovim terminal widget — tap-to-focus, swipe-to-scroll, pinch-to-zoom font size, and a draggable floating action button (FAB) that expands into a minimal Escape + sticky-Ctrl toolbar.

**Architecture:** All changes are purely frontend. A new `TouchGestureHandler` class attaches touch event listeners to the `NvimWidget` DOM node and translates them to xterm.js inputs. A new `TouchToolbar` class injects a FAB + expandable panel as a DOM overlay inside the widget container. `NvimWidget` constructs and disposes both in its existing lifecycle hooks. No backend changes, no new channels.

**Tech Stack:** TypeScript, xterm.js (`Terminal` API), Theia `BaseWidget`, vanilla DOM APIs (`TouchEvent`, `PointerEvent`), CSS custom properties for theming.

---

## Chunk 1: TouchGestureHandler

### Task 1: Create `app/src/browser/touch-gesture-handler.ts`

**Files:**
- Create: `app/src/browser/touch-gesture-handler.ts`

This class attaches to an xterm.js `Terminal` instance and the widget's DOM `node`. It handles:
- **Tap** → `term.focus()` (ensures xterm gets keyboard input after touch)
- **Swipe up/down** → `term.scrollLines(n)` (scrolls terminal content)
- **Pinch** → adjusts `term.options.fontSize` (clamp 10–24)

- [ ] **Step 1: Create the file with the full implementation**

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles (no errors expected yet — no imports from this file)**

```bash
cd /Users/nhath/Documents/projects/mineo/app && npx tsc --noEmit 2>&1 | head -40
```
Expected: no errors (or only pre-existing unrelated errors)

- [ ] **Step 3: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/touch-gesture-handler.ts
git commit -m "feat(touch): add TouchGestureHandler — tap, swipe, pinch-to-zoom"
```

---

## Chunk 2: TouchToolbar

### Task 2: Create `app/src/browser/touch-toolbar.ts`

**Files:**
- Create: `app/src/browser/touch-toolbar.ts`

The toolbar is a self-contained DOM component. It injects two elements into the widget's container node:
- **FAB** — a small circular draggable button (⌨ icon). Tap to toggle the panel open/closed. Drag to reposition.
- **Panel** — a small horizontal bar (hidden by default) containing two buttons: `ESC` and `CTRL` (sticky toggle).

When `CTRL` is active (sticky), the next key sent via `term.write` is prefixed with the Ctrl escape (`\x1b[` is NOT used here — Ctrl+key is encoded as the ASCII control character, e.g. Ctrl+C = `\x03`). The `TouchToolbar` constructor accepts a `sendKey: (data: string) => void` callback so it doesn't directly import `Terminal` — keeping it decoupled.

- [ ] **Step 1: Create the file with the full implementation**

```typescript
// app/src/browser/touch-toolbar.ts
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/nhath/Documents/projects/mineo/app && npx tsc --noEmit 2>&1 | head -40
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/touch-toolbar.ts
git commit -m "feat(touch): add TouchToolbar — draggable FAB + ESC/CTRL panel"
```

---

## Chunk 3: CSS for Touch Toolbar

### Task 3: Add touch toolbar styles to `suppress.css`

**Files:**
- Modify: `app/src/browser/style/suppress.css`

- [ ] **Step 1: Add `position: relative` to the existing `.nvim-widget` rule in suppress.css**

The existing `.nvim-widget` rule (inside the `/* ── NvimWidget fullscreen layout ─────── */` section) already sets `display: flex`, `flex-direction: column`, `overflow: hidden`. Add `position: relative` to that same rule block — do NOT create a second `.nvim-widget` rule:

```css
/* ── NvimWidget fullscreen layout ─────────────────────────────────────────── */
/* Make the widget node itself fill its Lumino slot */
.nvim-widget {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;   /* ← add this line — required for FAB/panel absolute positioning */
}
```

- [ ] **Step 2: Append the remaining touch toolbar CSS to the end of suppress.css**

Add the following block to the bottom of `app/src/browser/style/suppress.css` (FAB/panel rules only — `.nvim-widget` already handled above):

```css
/* ── Touch Toolbar ─────────────────────────────────────────────────────────── */

/* FAB — floating action button */
.nvim-touch-fab {
  position: absolute;
  bottom: 16px;
  right: 16px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #45475a;         /* catppuccin-mocha surface1 */
  color: #cdd6f4;               /* catppuccin-mocha text */
  font-size: 20px;
  line-height: 44px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  touch-action: none;           /* let pointer events through */
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  transition: background 0.15s;
}

.nvim-touch-fab:active {
  background: #585b70;          /* catppuccin-mocha surface2 */
}

/* Panel — expands above the FAB */
.nvim-touch-panel {
  position: absolute;
  display: flex;
  flex-direction: row;
  gap: 8px;
  padding: 6px 10px;
  background: #313244;          /* catppuccin-mocha surface0 */
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  z-index: 101;
  touch-action: none;
}

.nvim-touch-panel--hidden {
  display: none !important;
}

/* Individual key buttons */
.nvim-touch-btn {
  min-width: 52px;
  height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: #45475a;          /* catppuccin-mocha surface1 */
  color: #cdd6f4;
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  transition: background 0.1s;
}

.nvim-touch-btn:active,
.nvim-touch-btn--active {
  background: #89b4fa;          /* catppuccin-mocha blue — active/sticky state */
  color: #1e1e2f;
}
```

- [ ] **Step 3: Verify TypeScript still compiles (CSS changes don't affect TS)**

```bash
cd /Users/nhath/Documents/projects/mineo/app && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/style/suppress.css
git commit -m "feat(touch): add CSS for touch FAB and toolbar panel"
```

---

## Chunk 4: Wire into NvimWidget

### Task 4: Integrate TouchGestureHandler and TouchToolbar into `neovim-widget.ts`

**Files:**
- Modify: `app/src/browser/neovim-widget.ts`

`NvimWidget` will construct both helpers in `onAfterAttach` (after the terminal is opened and the DOM node is available) and register them with `this.toDispose` for automatic cleanup.

The `sendKey` callback passed to `TouchToolbar` writes directly to the data channel using the same `writeBytes` path already used by `term.onData`.

- [ ] **Step 1: Add imports at the top of neovim-widget.ts**

In `app/src/browser/neovim-widget.ts`, add two imports after the existing imports:

```typescript
import { TouchGestureHandler } from './touch-gesture-handler';
import { TouchToolbar } from './touch-toolbar';
```

- [ ] **Step 2: Update onAfterAttach to initialize touch helpers**

Replace the existing `onAfterAttach` method:

```typescript
protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    if (!this.termOpened) {
        this.term.open(this.node);
        this.termOpened = true;
        this.term.focus();
        this.fitAndResize();

        // Touch support — only attach when a touch device is detected
        if (window.matchMedia('(pointer: coarse)').matches) {
            const gestureHandler = new TouchGestureHandler(this.node, this.term);
            this.toDispose.push(gestureHandler);

            const enc = new TextEncoder();
            const toolbar = new TouchToolbar(this.node, {
                sendKey: (data: string) => {
                    if (this.dataChannel) {
                        this.dataChannel.getWriteBuffer()
                            .writeBytes(enc.encode(data))
                            .commit();
                    }
                },
            });
            this.toDispose.push(toolbar);
        }
    }
}
```

- [ ] **Step 3: Full build**

```bash
cd /Users/nhath/Documents/projects/mineo/app && npm run build 2>&1 | tail -20
```
Expected: `webpack compiled` (with 0 errors; warnings about bundle size are OK)

- [ ] **Step 4: Smoke test on desktop**

Open `http://localhost:3000` in Chrome DevTools device emulator (any phone preset). Verify:
1. FAB (⌨) is visible in the bottom-right corner of the Neovim pane
2. Tapping the FAB opens the panel showing `ESC` and `CTRL` buttons
3. Tapping `ESC` sends Escape to nvim (nvim returns to Normal mode)
4. Tapping `CTRL` turns it blue (sticky active); then tapping `ESC` sends Escape AND deactivates CTRL — button returns to its normal (non-blue) colour
5. Swiping up/down in the terminal scrolls content
6. On a non-touch desktop (pointer: fine), FAB does NOT appear

- [ ] **Step 5: Commit**

```bash
cd /Users/nhath/Documents/projects/mineo
git add app/src/browser/neovim-widget.ts
git commit -m "feat(touch): wire TouchGestureHandler and TouchToolbar into NvimWidget"
```

---

## Chunk 5: Full Build and Verification

### Task 5: Final verification

**Files:** (no new files — verification only)

- [ ] **Step 1: Run full build from repo root**

```bash
cd /Users/nhath/Documents/projects/mineo && npm run build 2>&1 | tail -30
```
Expected: `webpack compiled` with 0 errors

- [ ] **Step 2: Start server**

```bash
cd /Users/nhath/Documents/projects/mineo && node scripts/start.js &
```
Wait for `Mineo ready on http://0.0.0.0:3000`

- [ ] **Step 3: Verify touch FAB visible in device emulator**

Open Chrome DevTools → Toggle device toolbar → Select "iPhone 14 Pro" preset.
Navigate to `http://localhost:3000`.

Checklist:
- [ ] FAB (⌨) visible bottom-right of Neovim pane
- [ ] Tapping FAB shows ESC + CTRL panel above it
- [ ] Tapping FAB again hides panel
- [ ] Dragging FAB repositions it within the pane, panel repositions accordingly
- [ ] Tapping ESC in panel: nvim mode indicator changes (INSERT → NORMAL)
- [ ] Tapping CTRL makes button blue (sticky); tapping ESC after sends Escape AND deactivates CTRL (button returns to normal colour)
- [ ] Swipe up scrolls nvim content up
- [ ] Swipe down scrolls nvim content down
- [ ] Pinch-out increases font size (visible in terminal)
- [ ] Pinch-in decreases font size
- [ ] On desktop (no device emulator), FAB is NOT rendered

- [ ] **Step 4: Hard refresh and re-verify (clears webpack cache)**

Press Cmd+Shift+R in browser.
Re-verify FAB is visible and functional.

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
cd /Users/nhath/Documents/projects/mineo
git status  # should be clean if all previous commits were made
```
