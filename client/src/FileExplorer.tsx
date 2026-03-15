import { useState, useEffect, useCallback, useRef } from 'react';
import { getFileIcon, getOpenFolderIcon } from './file-icons';

interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    extension?: string;
}

interface TreeNode extends FileEntry {
    children?: TreeNode[];
    expanded?: boolean;
    loading?: boolean;
}

interface Props {
    rootDir?: string;
    onOpenFile: (filePath: string) => void;
}

interface ContextMenuState {
    x: number;
    y: number;
    node: TreeNode;
    parentDir: string;
}

interface InlineInputState {
    parentDir: string;
    kind: 'newFile' | 'newFolder' | 'rename';
    isDirectory: boolean;
    existingPath?: string;
    defaultValue: string;
    /** Insert before this path in the parent's children list */
    insertBeforePath?: string;
}

// ── API helpers ──

async function fetchDir(dir?: string): Promise<{ dir: string; entries: FileEntry[] }> {
    const url = dir ? `/api/files?dir=${encodeURIComponent(dir)}` : '/api/files';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);
    return res.json();
}

async function apiCreate(parentDir: string, name: string, isDirectory: boolean): Promise<void> {
    const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentDir, name, isDirectory }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create');
    }
}

async function apiRename(oldPath: string, newName: string): Promise<void> {
    const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newName }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to rename');
    }
}

async function apiDelete(targetPath: string): Promise<void> {
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete');
    }
}

// ── Inline input component ──

function InlineInput({
    defaultValue,
    depth,
    onSubmit,
    onCancel,
}: {
    defaultValue: string;
    depth: number;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        // Select filename without extension for rename
        const dotIdx = defaultValue.lastIndexOf('.');
        if (dotIdx > 0) {
            el.setSelectionRange(0, dotIdx);
        } else {
            el.select();
        }
    }, [defaultValue]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            const val = inputRef.current?.value.trim();
            if (val) onSubmit(val);
            else onCancel();
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    return (
        <div className="fe-inline-input" style={{ paddingLeft: depth * 16 + 8 }}>
            <input
                ref={inputRef}
                defaultValue={defaultValue}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                    const val = inputRef.current?.value.trim();
                    if (val && val !== defaultValue) onSubmit(val);
                    else onCancel();
                }}
            />
        </div>
    );
}

// ── Context menu component ──

function ContextMenu({
    x, y, node, onAction, onClose,
}: {
    x: number;
    y: number;
    node: TreeNode;
    onAction: (action: string) => void;
    onClose: () => void;
}) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Adjust position to stay within viewport
    const style: React.CSSProperties = { left: x, top: y };

    return (
        <div ref={menuRef} className="fe-context-menu" style={style}>
            {node.isDirectory && (
                <>
                    <div className="fe-context-item" onClick={() => onAction('newFile')}>New File</div>
                    <div className="fe-context-item" onClick={() => onAction('newFolder')}>New Folder</div>
                    <div className="fe-context-sep" />
                </>
            )}
            <div className="fe-context-item" onClick={() => onAction('rename')}>Rename</div>
            <div className="fe-context-item fe-context-item-danger" onClick={() => onAction('delete')}>Delete</div>
        </div>
    );
}

// ── Tree entry component ──

function TreeEntry({
    node,
    depth,
    onToggle,
    onOpenFile,
    onContextMenu,
    inlineInput,
    onInlineSubmit,
    onInlineCancel,
}: {
    node: TreeNode;
    depth: number;
    onToggle: (node: TreeNode) => void;
    onOpenFile: (path: string) => void;
    onContextMenu: (e: React.MouseEvent, node: TreeNode, parentDir: string) => void;
    inlineInput: InlineInputState | null;
    onInlineSubmit: (value: string) => void;
    onInlineCancel: () => void;
}) {
    const icon = node.isDirectory
        ? (node.expanded ? getOpenFolderIcon() : getFileIcon(undefined, true))
        : getFileIcon(node.extension, false, node.name);

    const isRenaming = inlineInput?.kind === 'rename' && inlineInput.existingPath === node.path;

    const handleClick = () => {
        if (node.isDirectory) {
            onToggle(node);
        } else {
            onOpenFile(node.path);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const parentDir = node.isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf('/'));
        onContextMenu(e, node, parentDir);
    };

    if (isRenaming) {
        return (
            <InlineInput
                defaultValue={node.name}
                depth={depth}
                onSubmit={onInlineSubmit}
                onCancel={onInlineCancel}
            />
        );
    }

    // Check if there's a new file/folder input that should appear as a child of this node
    const showNewInput = node.isDirectory && node.expanded &&
        inlineInput && (inlineInput.kind === 'newFile' || inlineInput.kind === 'newFolder') &&
        inlineInput.parentDir === node.path;

    return (
        <>
            <div
                className={`fe-entry ${node.isDirectory ? 'fe-dir' : ''}`}
                style={{ paddingLeft: depth * 16 + 8 }}
                onClick={handleClick}
                onContextMenu={handleContextMenu}
            >
                <span className="fe-icon" style={icon.deviconClass ? undefined : { color: icon.color }}>
                    {icon.deviconClass
                        ? <i className={icon.deviconClass} />
                        : <span dangerouslySetInnerHTML={{ __html: icon.svg ?? '' }} />
                    }
                </span>
                <span className="fe-name">{node.name}</span>
            </div>
            {node.expanded && node.loading && (
                <div className="fe-loading" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
                    loading...
                </div>
            )}
            {showNewInput && (
                <InlineInput
                    defaultValue=""
                    depth={depth + 1}
                    onSubmit={onInlineSubmit}
                    onCancel={onInlineCancel}
                />
            )}
            {node.expanded && node.children?.map(child => (
                <TreeEntry
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    onToggle={onToggle}
                    onOpenFile={onOpenFile}
                    onContextMenu={onContextMenu}
                    inlineInput={inlineInput}
                    onInlineSubmit={onInlineSubmit}
                    onInlineCancel={onInlineCancel}
                />
            ))}
        </>
    );
}

// ── Main component ──

export function FileExplorer({ rootDir, onOpenFile }: Props) {
    const [nodes, setNodes] = useState<TreeNode[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null);
    const rootDirRef = useRef<string | undefined>(rootDir);

    // Load root directory
    const loadRoot = useCallback(() => {
        fetchDir(rootDirRef.current)
            .then(data => {
                rootDirRef.current = data.dir;
                setNodes(data.entries.map(e => ({ ...e })));
            })
            .catch(err => setError(err.message));
    }, []);

    useEffect(() => { loadRoot(); }, [loadRoot]);

    // File watcher WebSocket — auto-refresh when files change
    useEffect(() => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/services/file-watch`);
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        ws.addEventListener('message', (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'change' && msg.dir) {
                    // Debounce — batch rapid changes
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        refreshDir(msg.dir);
                    }, 300);
                }
            } catch { /* ignore */ }
        });

        return () => {
            clearTimeout(debounceTimer);
            ws.close();
        };
    }, []);

    // Refresh a specific directory's children in the tree
    const refreshDir = useCallback((dir: string) => {
        // If it's the root dir, reload root
        if (dir === rootDirRef.current) {
            fetchDir(dir).then(data => {
                setNodes(prev => mergeRefresh(prev, data.entries));
            }).catch(() => {});
            return;
        }
        // Otherwise find and refresh the expanded node
        fetchDir(dir).then(data => {
            setNodes(prev => updateNode(prev, dir, {
                children: data.entries.map(e => {
                    // Preserve expanded state of existing children
                    const existing = findNode(prev, e.path);
                    return existing ? { ...e, expanded: existing.expanded, children: existing.children } : { ...e };
                }),
            }));
        }).catch(() => {});
    }, []);

    const toggleNode = useCallback((target: TreeNode) => {
        const update = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map(n => {
                if (n.path === target.path) {
                    if (n.expanded) {
                        return { ...n, expanded: false };
                    }
                    if (n.children) {
                        return { ...n, expanded: true };
                    }
                    const loading = { ...n, expanded: true, loading: true };
                    fetchDir(n.path)
                        .then(data => {
                            setNodes(prev => updateNode(prev, n.path, {
                                children: data.entries.map(e => ({ ...e })),
                                loading: false,
                            }));
                        })
                        .catch(() => {
                            setNodes(prev => updateNode(prev, n.path, {
                                children: [],
                                loading: false,
                            }));
                        });
                    return loading;
                }
                if (n.children) {
                    return { ...n, children: update(n.children) };
                }
                return n;
            });
        setNodes(prev => update(prev));
    }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode, parentDir: string) => {
        setContextMenu({ x: e.clientX, y: e.clientY, node, parentDir });
    }, []);

    const handleContextAction = useCallback((action: string) => {
        if (!contextMenu) return;
        const { node } = contextMenu;

        if (action === 'newFile' || action === 'newFolder') {
            // Ensure directory is expanded first
            if (!node.expanded) {
                toggleNode(node);
            }
            setInlineInput({
                parentDir: node.path,
                kind: action === 'newFile' ? 'newFile' : 'newFolder',
                isDirectory: action === 'newFolder',
                defaultValue: '',
            });
        } else if (action === 'rename') {
            setInlineInput({
                parentDir: node.path.substring(0, node.path.lastIndexOf('/')),
                kind: 'rename',
                isDirectory: node.isDirectory,
                existingPath: node.path,
                defaultValue: node.name,
            });
        } else if (action === 'delete') {
            const confirmed = window.confirm(`Delete "${node.name}"?`);
            if (confirmed) {
                apiDelete(node.path)
                    .then(() => {
                        const parentDir = node.path.substring(0, node.path.lastIndexOf('/'));
                        refreshDir(parentDir === rootDirRef.current ? parentDir : parentDir);
                    })
                    .catch(err => alert(`Delete failed: ${err.message}`));
            }
        }
        setContextMenu(null);
    }, [contextMenu, toggleNode, refreshDir]);

    const handleInlineSubmit = useCallback((value: string) => {
        if (!inlineInput) return;
        const { kind, parentDir, existingPath, isDirectory } = inlineInput;

        if (kind === 'rename' && existingPath) {
            apiRename(existingPath, value)
                .then(() => refreshDir(parentDir))
                .catch(err => alert(`Rename failed: ${err.message}`));
        } else {
            apiCreate(parentDir, value, isDirectory)
                .then(() => refreshDir(parentDir))
                .catch(err => alert(`Create failed: ${err.message}`));
        }
        setInlineInput(null);
    }, [inlineInput, refreshDir]);

    const handleInlineCancel = useCallback(() => {
        setInlineInput(null);
    }, []);

    // Right-click on empty area = new file/folder at root
    const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        if (rootDirRef.current) {
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                node: { name: '', path: rootDirRef.current, isDirectory: true, expanded: true },
                parentDir: rootDirRef.current,
            });
        }
    }, []);

    if (error) {
        return <div className="fe-root"><div className="fe-error">{error}</div></div>;
    }

    // Check for root-level new input
    const showRootInput = inlineInput &&
        (inlineInput.kind === 'newFile' || inlineInput.kind === 'newFolder') &&
        inlineInput.parentDir === rootDirRef.current;

    return (
        <div className="fe-root" onContextMenu={handleRootContextMenu}>
            {showRootInput && (
                <InlineInput
                    defaultValue=""
                    depth={0}
                    onSubmit={handleInlineSubmit}
                    onCancel={handleInlineCancel}
                />
            )}
            {nodes.map(node => (
                <TreeEntry
                    key={node.path}
                    node={node}
                    depth={0}
                    onToggle={toggleNode}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                    inlineInput={inlineInput}
                    onInlineSubmit={handleInlineSubmit}
                    onInlineCancel={handleInlineCancel}
                />
            ))}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    node={contextMenu.node}
                    onAction={handleContextAction}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}

// ── Tree helpers ──

function updateNode(nodes: TreeNode[], targetPath: string, patch: Partial<TreeNode>): TreeNode[] {
    return nodes.map(n => {
        if (n.path === targetPath) {
            return { ...n, ...patch };
        }
        if (n.children) {
            return { ...n, children: updateNode(n.children, targetPath, patch) };
        }
        return n;
    });
}

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.path === targetPath) return n;
        if (n.children) {
            const found = findNode(n.children, targetPath);
            if (found) return found;
        }
    }
    return undefined;
}

/** Merge refreshed entries into existing tree, preserving expanded state */
function mergeRefresh(existing: TreeNode[], fresh: FileEntry[]): TreeNode[] {
    return fresh.map(e => {
        const prev = existing.find(n => n.path === e.path);
        if (prev) {
            return { ...e, expanded: prev.expanded, children: prev.children };
        }
        return { ...e };
    });
}
