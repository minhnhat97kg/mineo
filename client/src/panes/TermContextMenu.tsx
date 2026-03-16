import { useEffect, useRef, useState, useCallback } from 'react';
import type { Terminal } from 'xterm';
import { useLongPress } from '../use-long-press';

interface MenuItem {
    label: string;
    disabled: boolean;
    action: () => void;
}

interface ContextMenuState {
    x: number;
    y: number;
    items: MenuItem[];
}

interface TermContextMenuProps {
    state: ContextMenuState | null;
    onClose: () => void;
}

export function TermContextMenu({ state, onClose }: TermContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!state) return;
        const onPointer = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('pointerdown', onPointer, { capture: true });
        return () => document.removeEventListener('pointerdown', onPointer, { capture: true });
    }, [state, onClose]);

    if (!state) return null;

    // Clamp to viewport so menu never goes off-screen
    const menuW = 160;
    const menuH = state.items.length * 40;
    const x = Math.min(state.x, window.innerWidth  - menuW - 8);
    const y = Math.min(state.y, window.innerHeight - menuH - 8);

    return (
        <div
            ref={menuRef}
            style={{
                position: 'fixed',
                left: x,
                top: y,
                width: menuW,
                background: '#2a2a2a',
                border: '1px solid #444',
                borderRadius: 8,
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                zIndex: 9999,
                overflow: 'hidden',
                userSelect: 'none',
            }}
        >
            {state.items.map((item, i) => (
                <div
                    key={i}
                    onPointerDown={e => { e.stopPropagation(); if (!item.disabled) { item.action(); onClose(); } }}
                    style={{
                        padding: '10px 16px',
                        fontSize: 14,
                        color: item.disabled ? '#555' : '#e5e7eb',
                        cursor: item.disabled ? 'default' : 'pointer',
                        borderBottom: i < state.items.length - 1 ? '1px solid #333' : 'none',
                    }}
                >
                    {item.label}
                </div>
            ))}
        </div>
    );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseTermContextMenuOptions {
    role: 'neovim' | 'terminal';
    elRef: React.RefObject<HTMLElement | null>;
    termRef: React.RefObject<Terminal | null>;
    sendData: (data: string) => void;
}

/**
 * Send an SGR right-click press + release at the terminal cell under (clientX, clientY).
 * neovim uses SGR mouse encoding: ESC [ < btn ; col ; row M/m
 * button 2 = right click (0-indexed), col/row are 1-indexed.
 */
function sendRightClick(term: Terminal, el: HTMLElement, clientX: number, clientY: number, sendData: (d: string) => void) {
    const rect = el.getBoundingClientRect();
    const cellW = rect.width  / term.cols;
    const cellH = rect.height / term.rows;
    const col = Math.max(1, Math.ceil((clientX - rect.left)  / cellW));
    const row = Math.max(1, Math.ceil((clientY - rect.top)   / cellH));
    // SGR: press then release
    sendData(`\x1b[<2;${col};${row}M`);
    sendData(`\x1b[<2;${col};${row}m`);
}

export function useTermContextMenu({ role, elRef, termRef, sendData }: UseTermContextMenuOptions) {
    const [menu, setMenu] = useState<ContextMenuState | null>(null);

    const close = useCallback(() => setMenu(null), []);

    const onLongPress = useCallback((clientX: number, clientY: number) => {
        const term = termRef.current;
        const el   = elRef.current;

        // Always send SGR right-click to the PTY — lets any terminal app (neovim,
        // fzf, mc, etc.) handle it natively. For plain shells with no mouse mode,
        // the sequence is silently ignored.
        if (term && el) {
            sendRightClick(term, el, clientX, clientY, sendData);
        }

        // Also show Copy/Paste overlay for terminal role — useful when no mouse
        // reporting app is active. Neovim handles its own menu so skip it.
        if (role === 'terminal') {
            const sel = termRef.current?.getSelection() ?? '';
            const items: MenuItem[] = [
                {
                    label: 'Copy',
                    disabled: !sel,
                    action: () => { if (sel) navigator.clipboard?.writeText(sel).catch(() => {}); },
                },
                {
                    label: 'Paste',
                    disabled: false,
                    action: () => {
                        navigator.clipboard?.readText().then(text => {
                            if (text) sendData(text);
                        }).catch(() => {});
                    },
                },
            ];
            setMenu({ x: clientX, y: clientY, items });
        }
    }, [role, elRef, termRef, sendData]);

    useLongPress(elRef, onLongPress);

    return { menu, close };
}
