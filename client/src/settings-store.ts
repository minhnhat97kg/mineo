export interface MineoSettings {
    fontFamily: string;
    fontSize: number;
    theme: string;
}

const DEFAULTS: MineoSettings = {
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    theme: 'mineo-dark',
};

type Listener = (settings: MineoSettings) => void;

class SettingsStore {
    private settings: MineoSettings = { ...DEFAULTS };
    private listeners = new Set<Listener>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    // Load settings from server; falls back to defaults on error.
    async load(): Promise<void> {
        try {
            const res = await fetch('/api/ui-settings');
            if (res.ok) {
                const data = await res.json();
                if (data.fontFamily) this.settings.fontFamily = data.fontFamily;
                if (typeof data.fontSize === 'number' && data.fontSize > 0) this.settings.fontSize = data.fontSize;
                if (data.theme) this.settings.theme = data.theme;
            }
        } catch { /* use defaults */ }
    }

    get(): MineoSettings {
        return { ...this.settings };
    }

    set(patch: Partial<MineoSettings>): void {
        let changed = false;
        for (const key of Object.keys(patch) as (keyof MineoSettings)[]) {
            if (patch[key] !== undefined && patch[key] !== this.settings[key]) {
                (this.settings as any)[key] = patch[key];
                changed = true;
            }
        }
        if (!changed) return;

        // Debounced save to server
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            fetch('/api/ui-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.settings),
            }).catch(() => {});
        }, 300);

        for (const cb of this.listeners) cb(this.get());
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
}

export const settingsStore = new SettingsStore();
