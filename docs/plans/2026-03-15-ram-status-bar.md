# RAM Usage Status Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display app RAM / total system RAM (e.g. `💾 128MB / 16GB`) in Theia's bottom status bar, polling every 5 seconds.

**Architecture:** Add a `/api/metrics` REST endpoint to the backend that returns RSS memory and total system RAM. A new `RamStatusContribution` on the frontend polls this endpoint every 5 seconds and injects a styled `<span>` element into `#theia-statusBar`.

**Tech Stack:** TypeScript, Theia framework (FrontendApplicationContribution), Node.js `os` module, Express REST.

---

### Task 1: Add `/api/metrics` backend endpoint

**Files:**
- Modify: `app/src/node/mineo-backend-module.ts`

**Step 1: Add `os` import at the top of the file**

In `app/src/node/mineo-backend-module.ts`, find the existing imports block:
```typescript
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
```

Add after them:
```typescript
import * as os from 'os';
```

**Step 2: Add the endpoint inside `MineoBACContribution.configure()`**

Find the `/api/nvim-ready` endpoint block (around line 185). Add the new endpoint right after the closing `});` of `/api/nvim-ready`:

```typescript
    // /api/metrics — returns app RSS memory and total system RAM
    app.get('/api/metrics', (_req, res) => {
      const appMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const totalGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      res.json({ appMB, totalGB });
    });
```

**Step 3: Verify the endpoint manually**

Start the app (`yarn start`) and run:
```bash
curl http://localhost:3000/api/metrics
```
Expected output:
```json
{"appMB":150,"totalGB":16}
```
(Numbers will vary by machine.)

**Step 4: Commit**

```bash
git add app/src/node/mineo-backend-module.ts
git commit -m "feat(backend): add /api/metrics endpoint for RAM usage"
```

---

### Task 2: Create `RamStatusContribution` frontend class

**Files:**
- Create: `app/src/browser/ram-status-contribution.ts`

**Step 1: Create the file**

```typescript
/**
 * RamStatusContribution — polls /api/metrics every 5s and injects
 * a RAM usage indicator into Theia's bottom status bar.
 * Displays: 💾 <appMB>MB / <totalGB>GB
 */

import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';

@injectable()
export class RamStatusContribution implements FrontendApplicationContribution {
    private spanEl: HTMLElement | null = null;
    private intervalId: ReturnType<typeof setInterval> | null = null;

    onStart(): void {
        this._injectSpan();
        this._poll();
        this.intervalId = setInterval(() => this._poll(), 5000);
    }

    onStop(): void {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private _injectSpan(): void {
        const statusBar = document.getElementById('theia-statusBar');
        if (!statusBar || statusBar.querySelector('.mineo-ram-status')) return;

        const span = document.createElement('span');
        span.className = 'mineo-ram-status';
        span.textContent = '💾 …';
        statusBar.appendChild(span);
        this.spanEl = span;
    }

    private async _poll(): Promise<void> {
        // Retry injection if the status bar wasn't ready during onStart
        if (!this.spanEl) {
            this._injectSpan();
        }
        if (!this.spanEl) return;

        try {
            const res = await fetch('/api/metrics');
            if (!res.ok) return;
            const data = await res.json() as { appMB: number; totalGB: number };
            this.spanEl.textContent = `💾 ${data.appMB}MB / ${data.totalGB}GB`;
        } catch {
            // Silently ignore network errors — stale value stays visible
        }
    }
}
```

**Step 2: Verify the file compiles**

```bash
cd app && npx tsc --noEmit 2>&1 | grep ram-status
```
Expected: no output (no errors).

**Step 3: Commit**

```bash
git add app/src/browser/ram-status-contribution.ts
git commit -m "feat(browser): add RamStatusContribution polling /api/metrics"
```

---

### Task 3: Register `RamStatusContribution` in the DI container

**Files:**
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Step 1: Add the import**

Find the imports block near the top of `app/src/browser/mineo-frontend-module.ts`. Add after the existing local imports:

```typescript
import { RamStatusContribution } from './ram-status-contribution';
```

**Step 2: Register in `ContainerModule`**

Find the block at the bottom of the file inside `new ContainerModule((bind, ...) => {`. Add right before the closing `});`:

```typescript
  // RAM usage indicator in the bottom status bar
  bind(RamStatusContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(RamStatusContribution);
```

**Step 3: Verify the file compiles**

```bash
cd app && npx tsc --noEmit 2>&1 | grep -E "error|ram"
```
Expected: no output.

**Step 4: Commit**

```bash
git add app/src/browser/mineo-frontend-module.ts
git commit -m "feat(module): register RamStatusContribution"
```

---

### Task 4: Add CSS styling for the RAM status element

**Files:**
- Modify: `app/src/browser/style/suppress.css`

**Step 1: Add styles at the end of the file**

Append to `app/src/browser/style/suppress.css`:

```css
/* ── RAM usage indicator in status bar ──────────────────────────────────── */

.mineo-ram-status {
  color: rgba(205, 214, 244, 0.55);
  font-size: 11px;
  padding: 0 8px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  user-select: none;
}

.mineo-ram-status:hover {
  color: rgba(205, 214, 244, 0.85);
}
```

**Step 2: Build and visually verify**

```bash
yarn build
yarn start
```

Open the app in browser. The bottom status bar should show `💾 XXXmb / YYgb` on the right side.

**Step 3: Commit**

```bash
git add app/src/browser/style/suppress.css
git commit -m "feat(styles): add RAM status indicator styling in status bar"
```

---

### Task 5: Verify end-to-end behavior

**Step 1: Full build and smoke test**

```bash
yarn build && yarn start
```

1. Open the app at `http://localhost:3000`
2. Check bottom status bar — expect `💾 XXXmb / YYgb` visible
3. Wait 5 seconds — number should update (may stay same if RAM is stable)
4. Confirm styling matches surrounding status bar items (dim, 11px)

**Step 2: Check no console errors**

Open browser DevTools → Console. There should be no errors related to `ram-status` or `/api/metrics`.

**Step 3: Check `/api/metrics` endpoint directly**

```bash
curl http://localhost:3000/api/metrics
```
Expected: `{"appMB":<number>,"totalGB":<number>}`
