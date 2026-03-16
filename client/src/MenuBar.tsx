import { useState, useEffect, useRef, useCallback } from 'react';
import { getAllPlugins } from './plugins/registry';
import type { ComponentType } from './panes/pane-types';

type PaneType = ComponentType;

interface MenuItem {
    label: string;
    action?: () => void;
    separator?: boolean;
}

interface MenuDef {
    label: string;
    items: MenuItem[];
}

interface Props {
    onAddPane: (role: PaneType) => void;
    keyboardLocked: boolean;
    onToggleKeyboard: () => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
}

// ── Input Modal ──

function InputModal({
    title,
    placeholder,
    onSubmit,
    onClose,
}: {
    title: string;
    placeholder: string;
    onSubmit: (value: string) => void;
    onClose: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            const val = inputRef.current?.value.trim();
            if (val) { onSubmit(val); onClose(); }
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    const handleConfirm = () => {
        const val = inputRef.current?.value.trim();
        if (val) { onSubmit(val); onClose(); }
    };

    return (
        <div className="mb-modal-overlay" onMouseDown={onClose}>
            <div className="mb-modal" onMouseDown={e => e.stopPropagation()}>
                <div className="mb-modal-title">{title}</div>
                <input
                    ref={inputRef}
                    className="mb-modal-input"
                    placeholder={placeholder}
                    onKeyDown={handleKeyDown}
                />
                <div className="mb-modal-actions">
                    <button className="mb-modal-btn mb-modal-btn-cancel" onClick={onClose}>Cancel</button>
                    <button className="mb-modal-btn mb-modal-btn-confirm" onClick={handleConfirm}>OK</button>
                </div>
            </div>
        </div>
    );
}

// ── Folder Picker Modal ──

interface BrowseEntry { name: string; path: string; }
interface BrowseResult { dir: string; parent: string | null; entries: BrowseEntry[]; }

function FolderPickerModal({
    initialDir,
    onSelect,
    onClose,
}: {
    initialDir: string;
    onSelect: (dir: string) => void;
    onClose: () => void;
}) {
    const [result, setResult] = useState<BrowseResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const browse = useCallback((dir: string) => {
        setLoading(true);
        setError(null);
        fetch(`/api/browse?dir=${encodeURIComponent(dir)}`)
            .then(r => r.json())
            .then((data: BrowseResult) => { setResult(data); setLoading(false); })
            .catch(err => { setError(err.message); setLoading(false); });
    }, []);

    useEffect(() => { browse(initialDir); }, [browse, initialDir]);

    const handleSelect = () => {
        if (result) onSelect(result.dir);
        onClose();
    };

    return (
        <div className="mb-modal-overlay" onMouseDown={onClose}>
            <div className="mb-modal mb-modal-picker" onMouseDown={e => e.stopPropagation()}>
                <div className="mb-modal-title">Open Workspace</div>
                <div className="mb-picker-path">{result?.dir ?? '…'}</div>
                <div className="mb-picker-list">
                    {loading && <div className="mb-picker-empty">Loading…</div>}
                    {error && <div className="mb-picker-empty mb-picker-error">{error}</div>}
                    {!loading && !error && result && (
                        <>
                            {result.parent && (
                                <div
                                    className="mb-picker-entry mb-picker-parent"
                                    onClick={() => browse(result.parent!)}
                                >
                                    ↑ ..
                                </div>
                            )}
                            {result.entries.length === 0 && (
                                <div className="mb-picker-empty">No subdirectories</div>
                            )}
                            {result.entries.map(e => (
                                <div
                                    key={e.path}
                                    className="mb-picker-entry"
                                    onClick={() => browse(e.path)}
                                >
                                    📁 {e.name}
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div className="mb-modal-actions">
                    <button className="mb-modal-btn mb-modal-btn-cancel" onClick={onClose}>Cancel</button>
                    <button
                        className="mb-modal-btn mb-modal-btn-confirm"
                        onClick={handleSelect}
                        disabled={!result}
                    >
                        Select
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Dropdown ──

function Dropdown({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        // Delay to avoid closing immediately from the trigger click
        const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
        return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
    }, [onClose]);

    return (
        <div ref={ref} className="mb-dropdown">
            {items.map((item, i) => {
                if (item.separator) return <div key={i} className="mb-sep" />;
                return (
                    <div
                        key={i}
                        className="mb-item"
                        onClick={() => { item.action?.(); onClose(); }}
                    >
                        {item.label}
                    </div>
                );
            })}
        </div>
    );
}

// ── MenuBar ──

type ModalState =
    | { kind: 'newFile' }
    | { kind: 'newFolder' }
    | { kind: 'openWorkspace' }
    | null;

export function MenuBar({ onAddPane, keyboardLocked, onToggleKeyboard, isFullscreen, onToggleFullscreen }: Props) {
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState>(null);

    const handleNewFile = useCallback(() => setModal({ kind: 'newFile' }), []);
    const handleNewFolder = useCallback(() => setModal({ kind: 'newFolder' }), []);
    const handleOpenWorkspace = useCallback(() => setModal({ kind: 'openWorkspace' }), []);

    const submitNewFile = useCallback((name: string) => {
        fetch('/api/files/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentDir: '', name, isDirectory: false }),
        }).then(async (res) => {
            if (!res.ok) {
                const ws = await fetch('/api/workspace').then(r => r.json());
                await fetch('/api/files/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parentDir: ws.workspace, name, isDirectory: false }),
                });
            }
        }).catch(() => {});
    }, []);

    const submitNewFolder = useCallback((name: string) => {
        fetch('/api/workspace').then(r => r.json()).then(ws => {
            fetch('/api/files/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parentDir: ws.workspace, name, isDirectory: true }),
            });
        }).catch(() => {});
    }, []);

    const submitOpenWorkspace = useCallback((dir: string) => {
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace: dir }),
        }).then(res => {
            if (res.ok) {
                window.location.reload();
            } else {
                alert('Failed to change workspace');
            }
        }).catch(() => alert('Failed to change workspace'));
    }, []);

    const plugins = getAllPlugins();

    const menus: MenuDef[] = [
        {
            label: 'File',
            items: [
                { label: 'New File', action: handleNewFile },
                { label: 'New Folder', action: handleNewFolder },
                { label: 'Open Workspace...', action: handleOpenWorkspace },
                { separator: true, label: '' },
                { label: 'Settings', action: () => onAddPane('settings') },
            ],
        },
        {
            label: 'View',
            items: [
                { label: 'Explorer', action: () => onAddPane('explorer') },
                { label: 'Terminal', action: () => onAddPane('terminal') },
                { label: 'Neovim', action: () => onAddPane('neovim') },
                { separator: true, label: '' },
                { label: isFullscreen ? 'Exit Fullscreen' : 'Fullscreen', action: onToggleFullscreen },
            ],
        },
        ...(plugins.length > 0 ? [{
            label: 'Plugins',
            items: plugins.map(p => ({
                label: p.title,
                action: () => onAddPane(`plugin:${p.id}` as PaneType),
            })),
        }] : []),
    ];

    const handleTrigger = (label: string) => {
        setOpenMenu(prev => prev === label ? null : label);
    };

    return (
        <>
            <div className="mb-bar">
                {menus.map(menu => (
                    <div key={menu.label} className="mb-menu">
                        <button
                            className={`mb-menu-trigger ${openMenu === menu.label ? 'mb-open' : ''}`}
                            onClick={() => handleTrigger(menu.label)}
                            onMouseEnter={() => { if (openMenu) setOpenMenu(menu.label); }}
                        >
                            {menu.label}
                        </button>
                        {openMenu === menu.label && (
                            <Dropdown items={menu.items} onClose={() => setOpenMenu(null)} />
                        )}
                    </div>
                ))}
                <div className="mb-spacer" />
                <button
                    className={`mb-kbd-toggle ${keyboardLocked ? 'mb-kbd-locked' : 'mb-kbd-unlocked'}`}
                    onClick={onToggleKeyboard}
                    title={keyboardLocked ? 'Keyboard locked — tap to enable' : 'Keyboard enabled — tap to lock'}
                >
                    ⌨
                </button>
            </div>

            {modal?.kind === 'newFile' && (
                <InputModal
                    title="New File"
                    placeholder="File name"
                    onSubmit={submitNewFile}
                    onClose={() => setModal(null)}
                />
            )}
            {modal?.kind === 'newFolder' && (
                <InputModal
                    title="New Folder"
                    placeholder="Folder name"
                    onSubmit={submitNewFolder}
                    onClose={() => setModal(null)}
                />
            )}
            {modal?.kind === 'openWorkspace' && (
                <WorkspacePickerModal
                    onSelect={submitOpenWorkspace}
                    onClose={() => setModal(null)}
                />
            )}
        </>
    );
}

// Wrapper that fetches the current workspace to seed the folder picker
function WorkspacePickerModal({ onSelect, onClose }: { onSelect: (dir: string) => void; onClose: () => void }) {
    const [initialDir, setInitialDir] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/workspace')
            .then(r => r.json())
            .then(data => setInitialDir(data.workspace))
            .catch(() => setInitialDir('/'));
    }, []);

    if (!initialDir) return null;
    return <FolderPickerModal initialDir={initialDir} onSelect={onSelect} onClose={onClose} />;
}
