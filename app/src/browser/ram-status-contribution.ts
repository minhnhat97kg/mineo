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
