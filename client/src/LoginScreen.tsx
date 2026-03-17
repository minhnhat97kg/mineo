import { useState, useCallback, useRef, useEffect } from 'react';

interface LoginScreenProps {
    onSuccess: () => void;
}

export function LoginScreen({ onSuccess }: LoginScreenProps) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const submit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password || loading) return;

        setLoading(true);
        setError('');

        try {
            const body = new URLSearchParams({ password });
            const res = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                redirect: 'manual',
            });

            if (res.type === 'opaqueredirect' || res.ok) {
                const check = await fetch('/api/files', { cache: 'no-store' });
                if (check.ok) {
                    onSuccess();
                    return;
                }
            }
            setError('Incorrect password');
        } catch {
            setError('Network error — please try again');
        } finally {
            setLoading(false);
        }
    }, [password, loading, onSuccess]);

    return (
        <div style={{
            position: 'fixed', inset: 0,
            background: 'var(--pane-bg, #121212)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}>
            <form
                onSubmit={submit}
                style={{
                    background: 'var(--ui-surface, #1e1e1e)',
                    border: '1px solid var(--ui-border, #2a2a2a)',
                    borderRadius: 8,
                    padding: '24px 28px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
                    minWidth: 260,
                    maxWidth: 320,
                    width: '100%',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
            >
                {/* Logo */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ fontSize: 28 }}>🧠</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ui-text, #e5e7eb)', letterSpacing: '-0.01em' }}>
                        Mineo
                    </div>
                </div>

                {/* Password */}
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input
                        ref={inputRef}
                        type="password"
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError(''); }}
                        placeholder="Password"
                        autoComplete="current-password"
                        style={{
                            width: '100%',
                            height: 30,
                            padding: '0 10px',
                            background: 'var(--ui-bg, #121212)',
                            border: `1px solid ${error ? '#f87171' : 'var(--ui-border, #2a2a2a)'}`,
                            borderRadius: 4,
                            color: 'var(--ui-text, #e5e7eb)',
                            fontSize: 12,
                            outline: 'none',
                            transition: 'border-color 0.12s, box-shadow 0.12s',
                            fontFamily: "'JetBrains Mono', Menlo, monospace",
                        }}
                        onFocus={e => { if (!error) { e.currentTarget.style.borderColor = 'var(--ui-accent, #60a5fa)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(96,165,250,0.15)'; }}}
                        onBlur={e => { if (!error) { e.currentTarget.style.borderColor = 'var(--ui-border, #2a2a2a)'; e.currentTarget.style.boxShadow = 'none'; }}}
                    />
                    {error && (
                        <div style={{ fontSize: 10, color: '#f87171', textAlign: 'center' }}>
                            {error}
                        </div>
                    )}
                </div>

                {/* Submit */}
                <button
                    type="submit"
                    disabled={loading || !password}
                    style={{
                        width: '100%',
                        height: 30,
                        background: loading || !password ? 'var(--ui-surface, #1e1e1e)' : 'var(--ui-accent, #60a5fa)',
                        color: loading || !password ? '#6b7280' : '#fff',
                        border: loading || !password ? '1px solid var(--ui-border, #2a2a2a)' : 'none',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: loading || !password ? 'default' : 'pointer',
                        transition: 'background 0.12s, color 0.12s, opacity 0.12s',
                    }}
                >
                    {loading ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
