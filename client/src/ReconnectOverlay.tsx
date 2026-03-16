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

    // Listen for WebSocket close events bubbled up via a custom DOM event
    useEffect(() => {
        const handler = () => {
            setDisconnected(true);
            setAttempt(0);
        };
        window.addEventListener('mineo:disconnected', handler);
        return () => window.removeEventListener('mineo:disconnected', handler);
    }, []);

    // Exponential-backoff retry loop — re-runs each time attempt changes
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
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                background: '#1e1e1e',
                border: '1px solid #444',
                borderRadius: 10,
                padding: '28px 36px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
                minWidth: 260,
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            }}>
                <div style={{ fontSize: 32 }}>🔌</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#e5e7eb' }}>
                    Server disconnected
                </div>
                <div style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>
                    Reconnecting in <span style={{ color: '#f87171', fontWeight: 700 }}>{countdown}s</span>… (attempt {attempt + 1})
                </div>
                <button
                    onClick={handleReconnectNow}
                    style={{
                        marginTop: 4,
                        padding: '7px 22px',
                        background: '#3b82f6',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >
                    Reconnect now
                </button>
            </div>
        </div>
    );
}
