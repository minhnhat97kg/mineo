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
                redirect: 'manual', // don't follow redirect — detect success ourselves
            });

            // Server redirects to "/" on success, stays on /login on failure.
            // With redirect:'manual', a redirect comes back as opaqueredirect (type=opaqueredirect).
            // We check for a 302 (opaqueredirect) or a 200 to /login (wrong password).
            if (res.type === 'opaqueredirect' || res.ok) {
                // Verify we actually have a valid session now
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
            background: '#121212',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
            <form
                onSubmit={submit}
                style={{
                    background: '#1e1e1e',
                    border: '1px solid #333',
                    borderRadius: 12,
                    padding: '36px 40px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
                    minWidth: 300,
                    boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
                }}
            >
                {/* Logo / title */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 36 }}>🧠</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#e5e7eb', letterSpacing: '-0.01em' }}>
                        Mineo
                    </div>
                </div>

                {/* Password field */}
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <input
                        ref={inputRef}
                        type="password"
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError(''); }}
                        placeholder="Password"
                        autoComplete="current-password"
                        style={{
                            width: '100%',
                            padding: '10px 14px',
                            background: '#2a2a2a',
                            border: `1px solid ${error ? '#ef4444' : '#444'}`,
                            borderRadius: 7,
                            color: '#e5e7eb',
                            fontSize: 15,
                            outline: 'none',
                            transition: 'border-color 0.15s',
                            fontFamily: 'inherit',
                        }}
                        onFocus={e => { if (!error) e.currentTarget.style.borderColor = '#3b82f6'; }}
                        onBlur={e => { if (!error) e.currentTarget.style.borderColor = '#444'; }}
                    />
                    {error && (
                        <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center' }}>
                            {error}
                        </div>
                    )}
                </div>

                {/* Submit button */}
                <button
                    type="submit"
                    disabled={loading || !password}
                    style={{
                        width: '100%',
                        padding: '10px 0',
                        background: loading || !password ? '#2a2a2a' : '#3b82f6',
                        color: loading || !password ? '#6b7280' : '#fff',
                        border: 'none',
                        borderRadius: 7,
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: loading || !password ? 'default' : 'pointer',
                        transition: 'background 0.15s, color 0.15s',
                    }}
                >
                    {loading ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
