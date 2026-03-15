# Menu Bar Collapse/Expand Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `‹`/`›` chevron button to the top bar that collapses/expands the menu bar, with state persisted in localStorage.

**Architecture:** A new `MenuBarToggleContribution` class in `mineo-frontend-module.ts` injects a chevron button into `#theia-top-panel` on `onStart`. Clicking toggles the `menu-collapsed` class on `#theia-top-panel`. CSS in `suppress.css` animates the bar to 0 height when collapsed; the chevron is `position: fixed` so it stays visible. State is read from/written to `localStorage`.

**Tech Stack:** TypeScript (Theia `FrontendApplicationContribution`), CSS (transitions, `position: fixed`)

---

### Task 1: Add collapse/expand CSS to suppress.css

**Files:**
- Modify: `app/src/browser/style/suppress.css`

**Step 1: Add the CSS**

Open `app/src/browser/style/suppress.css` and append the following block at the end of the file:

```css
/* ── Menu Bar Collapse/Expand ──────────────────────────────────────────────── */

/* Collapsed state: top panel animates to zero height */
#theia-top-panel.menu-collapsed {
  max-height: 0 !important;
  padding: 0 !important;
  opacity: 0 !important;
  pointer-events: none !important;
  overflow: hidden !important;
}

/* Smooth transition for collapse/expand */
#theia-top-panel {
  max-height: 36px;
  transition: max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease;
}

/* Chevron toggle button — fixed so it survives bar collapse */
.nvim-menu-toggle {
  position: fixed;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  z-index: 200;
  background: rgba(17, 17, 27, 0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: none;
  border-bottom-right-radius: 6px;
  color: rgba(205, 214, 244, 0.45);
  font-size: 11px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, background 0.15s;
  display: none; /* hidden until contribution mounts it */
}

.nvim-menu-toggle:hover {
  color: rgba(205, 214, 244, 0.9);
  background: rgba(17, 17, 27, 0.75);
}

/* Only show the toggle button when the menu is collapsed */
#theia-top-panel.menu-collapsed ~ .nvim-menu-toggle,
body.nvim-menu-collapsed .nvim-menu-toggle {
  display: block;
}
```

**Step 2: Verify the file saved correctly**

Open `app/src/browser/style/suppress.css` and confirm the new block appears at the bottom.

**Step 3: Commit**

```bash
git add app/src/browser/style/suppress.css
git commit -m "feat(menu): add CSS for menu bar collapse/expand toggle"
```

---

### Task 2: Add MenuBarToggleContribution to mineo-frontend-module.ts

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Step 1: Add the contribution class**

After the `TouchScrollContribution` class (around line 164), insert this new class:

```typescript
/**
 * MenuBarToggleContribution — adds a chevron button that collapses/expands
 * the top menu bar. State is persisted in localStorage.
 */
@injectable()
class MenuBarToggleContribution implements FrontendApplicationContribution {
  private static readonly STORAGE_KEY = 'mineo.menuBarCollapsed';

  onStart(): void {
    const collapsed = localStorage.getItem(MenuBarToggleContribution.STORAGE_KEY) === '1';

    // Create the fixed chevron button
    const btn = document.createElement('button');
    btn.className = 'nvim-menu-toggle';
    btn.title = 'Toggle menu bar';
    document.body.appendChild(btn);

    const apply = (isCollapsed: boolean): void => {
      const panel = document.getElementById('theia-top-panel');
      if (panel) {
        panel.classList.toggle('menu-collapsed', isCollapsed);
      }
      btn.textContent = isCollapsed ? '›' : '‹';
      btn.style.display = isCollapsed ? 'block' : '';
      localStorage.setItem(MenuBarToggleContribution.STORAGE_KEY, isCollapsed ? '1' : '0');
    };

    btn.addEventListener('click', () => {
      const panel = document.getElementById('theia-top-panel');
      const isNowCollapsed = panel ? !panel.classList.contains('menu-collapsed') : false;
      apply(isNowCollapsed);
    });

    // Restore persisted state after the shell has rendered
    // (small delay so #theia-top-panel exists in DOM)
    setTimeout(() => apply(collapsed), 100);
  }
}
```

**Step 2: Register the contribution in the ContainerModule**

In the `export default new ContainerModule(...)` block at the bottom of the file, after the `TouchScrollContribution` binding (around line 402), add:

```typescript
  // Menu bar collapse/expand toggle
  bind(FrontendApplicationContribution).to(MenuBarToggleContribution).inSingletonScope();
```

**Step 3: Build and verify**

```bash
cd /Users/nhath/Documents/projects/mineo
yarn --cwd app build 2>&1 | tail -20
```

Expected: no TypeScript errors, build completes.

**Step 4: Run the app and manually test**

```bash
yarn start
```

- Open the app in browser
- Confirm a small `‹` chevron appears at top-left
- Click it — top bar should animate/collapse to 0 height, chevron changes to `›`
- Click `›` — top bar should expand back
- Reload page — collapsed state should be restored from localStorage

**Step 5: Commit**

```bash
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat(menu): add MenuBarToggleContribution with chevron button"
```
