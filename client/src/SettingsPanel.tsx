import { useState, useEffect, useCallback } from 'react';
import { settingsStore, MineoSettings } from './settings-store';
import { THEMES } from './themes';

interface LspEntry {
    lang: string;
    bin: string;
    installed: boolean;
    running: boolean;
}

export function SettingsPanel() {
    const [settings, setSettings] = useState<MineoSettings>(settingsStore.get());
    const [workspace, setWorkspace] = useState('');
    const [nvimBin, setNvimBin] = useState('nvim');
    const [configMode, setConfigMode] = useState('system');
    const [configDir, setConfigDir] = useState('');
    const [status, setStatus] = useState<{ msg: string; error?: boolean } | null>(null);
    const [lspServers, setLspServers] = useState<LspEntry[]>([]);

    useEffect(() => {
        return settingsStore.subscribe(setSettings);
    }, []);

    // Load server-side settings
    useEffect(() => {
        fetch('/api/config').then(r => r.json()).then(d => {
            if (d.workspace) setWorkspace(d.workspace);
        }).catch(() => {});

        fetch('/api/nvim-config').then(r => r.json()).then(d => {
            if (d.bin) setNvimBin(d.bin);
            if (d.configMode) setConfigMode(d.configMode);
            if (d.configDir) setConfigDir(d.configDir);
        }).catch(() => {});
    }, []);

    // Load + poll LSP status every 3 s so Running badge updates live
    useEffect(() => {
        const load = () =>
            fetch('/api/lsp/status').then(r => r.json()).then((d: LspEntry[]) => setLspServers(d)).catch(() => {});
        load();
        const id = setInterval(load, 3000);
        return () => clearInterval(id);
    }, []);

    const flash = useCallback((msg: string, error = false) => {
        setStatus({ msg, error });
        setTimeout(() => setStatus(null), 2000);
    }, []);

    const handleFontFamily = (v: string) => settingsStore.set({ fontFamily: v });
    const handleFontSize = (v: number) => { if (v >= 8 && v <= 32) settingsStore.set({ fontSize: v }); };
    const handleTheme = (v: string) => settingsStore.set({ theme: v });

    const saveWorkspace = () => {
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace }),
        }).then(r => {
            if (r.ok) { flash('Saved'); window.location.reload(); }
            else flash('Failed to save', true);
        }).catch(() => flash('Failed to save', true));
    };

    const saveNvim = () => {
        fetch('/api/nvim-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bin: nvimBin, configMode, configDir }),
        }).then(r => {
            if (r.ok) flash('Saved — restart neovim panes to apply');
            else flash('Failed to save', true);
        }).catch(() => flash('Failed to save', true));
    };

    const stopLsp = (lang: string) => {
        fetch('/api/lsp/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang }),
        }).then(r => r.json()).then(() => {
            // optimistically mark as stopped; poll will confirm
            setLspServers(prev => prev.map(e => e.lang === lang ? { ...e, running: false } : e));
        }).catch(() => {});
    };

    return (
        <div className="sp-root">
            <div className="sp-title">Settings</div>

            <div className="sp-section">
                <div className="sp-section-title">Appearance</div>

                <div className="sp-field">
                    <label className="sp-label">Font Family</label>
                    <input
                        className="sp-input"
                        value={settings.fontFamily}
                        onChange={e => handleFontFamily(e.target.value)}
                    />
                </div>

                <div className="sp-field">
                    <label className="sp-label">Font Size</label>
                    <input
                        className="sp-input sp-input-number"
                        type="number"
                        min={8}
                        max={32}
                        value={settings.fontSize}
                        onChange={e => handleFontSize(Number(e.target.value))}
                    />
                </div>

                <div className="sp-field">
                    <label className="sp-label">Theme</label>
                    <select
                        className="sp-select"
                        value={settings.theme}
                        onChange={e => handleTheme(e.target.value)}
                    >
                        {Object.keys(THEMES).map(name => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="sp-section">
                <div className="sp-section-title">Workspace</div>
                <div className="sp-field">
                    <label className="sp-label">Directory</label>
                    <div className="sp-desc">Absolute path to the workspace root. Changes reload the page.</div>
                    <div className="sp-row">
                        <input
                            className="sp-input"
                            value={workspace}
                            onChange={e => setWorkspace(e.target.value)}
                        />
                        <button className="sp-btn" onClick={saveWorkspace}>Save</button>
                    </div>
                </div>
            </div>

            <div className="sp-section">
                <div className="sp-section-title">Neovim</div>

                <div className="sp-field">
                    <label className="sp-label">Binary Path</label>
                    <input
                        className="sp-input"
                        value={nvimBin}
                        onChange={e => setNvimBin(e.target.value)}
                    />
                </div>

                <div className="sp-field">
                    <label className="sp-label">Config Mode</label>
                    <select
                        className="sp-select"
                        value={configMode}
                        onChange={e => setConfigMode(e.target.value)}
                    >
                        <option value="system">System (~/.config/nvim)</option>
                        <option value="bundled">Bundled (mineo default)</option>
                        <option value="custom">Custom directory</option>
                    </select>
                </div>

                {configMode === 'custom' && (
                    <div className="sp-field">
                        <label className="sp-label">Custom Config Directory</label>
                        <input
                            className="sp-input"
                            value={configDir}
                            onChange={e => setConfigDir(e.target.value)}
                        />
                    </div>
                )}

                <div className="sp-row">
                    <button className="sp-btn" onClick={saveNvim}>Save Neovim Config</button>
                    {status && (
                        <span className={`sp-status ${status.error ? 'sp-status-error' : ''}`}>
                            {status.msg}
                        </span>
                    )}
                </div>
            </div>

            <div className="sp-section">
                <div className="sp-section-title">LSP Servers</div>
                <div className="sp-desc" style={{ marginBottom: 10 }}>
                    Language servers are started on demand when a client connects via <code>/lsp/&lt;lang&gt;</code>.
                    Install the binary for a language to enable it.
                </div>
                <table className="sp-lsp-table">
                    <thead>
                        <tr>
                            <th>Language</th>
                            <th>Binary</th>
                            <th>Status</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {lspServers.map(e => (
                            <tr key={e.lang}>
                                <td className="sp-lsp-lang">{e.lang}</td>
                                <td className="sp-lsp-bin">{e.bin}</td>
                                <td>
                                    {e.running
                                        ? <span className="sp-lsp-badge sp-lsp-running">running</span>
                                        : e.installed
                                            ? <span className="sp-lsp-badge sp-lsp-installed">installed</span>
                                            : <span className="sp-lsp-badge sp-lsp-missing">not installed</span>
                                    }
                                </td>
                                <td>
                                    {e.running && (
                                        <button className="sp-btn sp-btn-danger" onClick={() => stopLsp(e.lang)}>
                                            Stop
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
