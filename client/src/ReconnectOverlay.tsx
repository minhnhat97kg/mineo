import { useEffect, useState } from 'react';

const PING_URL = '/api/files';
const INITIAL_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const BACKOFF = 1.5;

function getDelay(attempt: number): number {
    return Math.min(INITIAL_DELAY_MS * Math.pow(BACKOFF, attempt), MAX_DELAY_MS);
}

async function ping(): Promise<boolean> {
    try {
        const res = await fetch(PING_URL, { cache: 'no-store' });
        return res.ok;
    } catch {
        return false;
    }
}

export function ReconnectOverlay() {
    const [disconnected, setDisconnected] = useState(false);
    const [countdown, setCountdown] = useState(INITIAL_DELAY_MS / 1000);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const handler = () => {
            setDisconnected(true);
            setAttempt(0);
        };
        window.addEventListener('mineo:disconnected', handler);
        return () => window.removeEventListener('mineo:disconnected', handler);
    }, []);

    useEffect(() => {
        if (!disconnected) return;
        const delay = getDelay(attempt);
        setCountdown(Math.round(delay / 1000));

        const countInterval = setInterval(() => setCountdown(c => Math.max(c - 1, 0)), 1000);
        const retryTimer = setTimeout(async () => {
            clearInterval(countInterval);
            const ok = await ping();
            if (ok) { window.location.reload(); return; }
            setAttempt(a => a + 1);
        }, delay);

        return () => { clearInterval(countInterval); clearTimeout(retryTimer); };
    }, [disconnected, attempt]);

    if (!disconnected) return null;

    const handleReconnectNow = async () => {
        const ok = await ping();
        if (ok) { window.location.reload(); return; }
        setAttempt(a => a + 1);
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(2px)',
        }}>
            <div style={{
                background: 'var(--ui-surface, #1e1e1e)',
                border: '1px solid var(--ui-border, #2a2a2a)',
                borderRadius: 8,
                padding: '18px 24px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                minWidth: 220,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            }}>
                <div style={{ fontSize: 24 }}>🔌</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text, #e5e7eb)' }}>
                    Server disconnected
                </div>
                <div style={{ fontSize: 11, color: 'var(--ui-text-muted, #9ca3af)', textAlign: 'center' }}>
                    Reconnecting in <span style={{ color: '#f87171', fontWeight: 700 }}>{countdown}s</span>… (attempt {attempt + 1})
                </div>
                <button
                    onClick={handleReconnectNow}
                    style={{
                        marginTop: 2,
                        height: 26,
                        padding: '0 16px',
                        background: 'var(--ui-accent, #60a5fa)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'opacity 0.1s',
                    }}
                >
                    Reconnect now
                </button>
            </div>
        </div>
    );
}
