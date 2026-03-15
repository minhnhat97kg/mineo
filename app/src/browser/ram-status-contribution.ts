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
    private polling = false;

    onStart(): void {
        this.injectSpan();
        this.poll();
        this.intervalId = setInterval(() => this.poll(), 5000);
    }

    onStop(): void {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private injectSpan(): void {
        const statusBar = document.getElementById('theia-statusBar');
        if (!statusBar || statusBar.querySelector('.mineo-ram-status')) return;

        const span = document.createElement('span');
        span.className = 'mineo-ram-status';
        span.textContent = '💾 …';
        statusBar.appendChild(span);
        this.spanEl = span;
    }

    private async poll(): Promise<void> {
        if (this.polling) return;
        if (!this.spanEl) {
            this.injectSpan();
        }
        if (!this.spanEl) return;

        this.polling = true;
        try {
            const res = await fetch('/api/metrics');
            if (!res.ok) return;
            const data = await res.json() as { appMB: number; totalGB: number };
            this.spanEl.textContent = `💾 ${data.appMB}MB / ${data.totalGB}GB`;
        } catch {
            // Silently ignore network errors — stale value stays visible
        } finally {
            this.polling = false;
        }
    }
}
