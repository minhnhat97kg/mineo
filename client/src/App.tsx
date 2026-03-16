import { useRef, useState, useEffect, useCallback } from 'react';
import { MenuBar } from './MenuBar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';
import { ReconnectOverlay } from './ReconnectOverlay';
import { LoginScreen } from './LoginScreen';
import type { ComponentType } from './panes/pane-types';

// iOS Safari does not support the Fullscreen API at all.
const supportsFullscreen = !!document.documentElement.requestFullscreen;

// 'checking' | 'login' | 'app'
type AuthState = 'checking' | 'login' | 'app';

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);
    const [keyboardLocked, setKeyboardLocked] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [authState, setAuthState] = useState<AuthState>('checking');

    // On mount, probe a protected endpoint to decide whether to show login screen.
    useEffect(() => {
        fetch('/api/files', { cache: 'no-store', redirect: 'manual' })
            .then(res => {
                // opaqueredirect means the server redirected to /login (not authed)
                if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 302) {
                    setAuthState('login');
                } else {
                    setAuthState('app');
                }
            })
            .catch(() => setAuthState('app')); // network error — let the app handle it
    }, []);

    // Track real fullscreen changes (non-iOS)
    useEffect(() => {
        if (!supportsFullscreen) return;
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    const toggleFullscreen = useCallback(() => {
        if (supportsFullscreen) {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                document.documentElement.requestFullscreen().catch(() => {});
            }
        } else {
            // iOS fallback: toggle a CSS class that covers the whole viewport
            setIsFullscreen(v => !v);
        }
    }, []);

    const handleAddPane = (role: ComponentType) => layoutRef.current?.addPane(role);

    // Show nothing while probing auth (avoids flash of login screen for authed users)
    if (authState === 'checking') return null;

    if (authState === 'login') {
        return <LoginScreen onSuccess={() => setAuthState('app')} />;
    }

    return (
        // On iOS, .app-fullscreen makes #mineo-root cover the whole screen
        <div style={!supportsFullscreen && isFullscreen ? {
            position: 'fixed', inset: 0, zIndex: 9000,
            display: 'flex', flexDirection: 'column',
            background: '#121212',
        } : { display: 'contents' }}>
            <MenuBar
                onAddPane={handleAddPane}
                keyboardLocked={keyboardLocked}
                onToggleKeyboard={() => setKeyboardLocked(v => !v)}
                isFullscreen={isFullscreen}
                onToggleFullscreen={toggleFullscreen}
            />
            <LayoutContainer ref={layoutRef} keyboardLocked={keyboardLocked} />
            <ReconnectOverlay />
        </div>
    );
}
