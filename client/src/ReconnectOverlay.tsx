import { useEffect, useState, useRef } from 'react';

const PING_URL = '/api/files';
const RETRY_MS = 5000;

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
    const [countdown, setCountdown] = useState(RETRY_MS / 1000);
    const timerRef   = useRef<ReturnType<typeof setTimeout>  | undefined>(undefined);
    const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    const attemptReconnect = () => {
        ping().then(ok => {
            if (ok) {
                window.location.reload();
            } else {
                startCountdown();
            }
        });
    };

    const startCountdown = () => {
        clearInterval(intervalRef.current);
        clearTimeout(timerRef.current);
        let secs = RETRY_MS / 1000;
        setCountdown(secs);
        intervalRef.current = setInterval(() => {
            secs -= 1;
            setCountdown(secs);
        }, 1000);
        timerRef.current = setTimeout(() => {
            clearInterval(intervalRef.current);
            attemptReconnect();
        }, RETRY_MS);
    };

    // Listen for WebSocket close events bubbled up via a custom DOM event
    useEffect(() => {
        const handler = () => {
            setDisconnected(true);
            startCountdown();
        };
        window.addEventListener('mineo:disconnected', handler);
        return () => {
            window.removeEventListener('mineo:disconnected', handler);
            clearTimeout(timerRef.current);
            clearInterval(intervalRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!disconnected) return null;

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
                    Reconnecting in <span style={{ color: '#f87171', fontWeight: 700 }}>{countdown}s</span>…
                </div>
                <button
                    onClick={() => { clearTimeout(timerRef.current); clearInterval(intervalRef.current); attemptReconnect(); }}
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
