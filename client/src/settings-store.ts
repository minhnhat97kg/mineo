const STORAGE_KEY = 'mineo-settings';

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
    private settings: MineoSettings;
    private listeners = new Set<Listener>();

    constructor() {
        this.settings = { ...DEFAULTS };
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.fontFamily) this.settings.fontFamily = parsed.fontFamily;
                if (typeof parsed.fontSize === 'number') this.settings.fontSize = parsed.fontSize;
                if (parsed.theme) this.settings.theme = parsed.theme;
            }
        } catch { /* ignore */ }
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
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
        } catch { /* ignore */ }
        for (const cb of this.listeners) cb(this.get());
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
}

export const settingsStore = new SettingsStore();
