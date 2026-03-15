import { useRef, useState, useEffect, useCallback } from 'react';
import { MenuBar } from './MenuBar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';
import { ReconnectOverlay } from './ReconnectOverlay';

type PaneType = 'neovim' | 'terminal' | 'explorer' | 'settings';

// iOS Safari does not support the Fullscreen API at all.
const supportsFullscreen = !!document.documentElement.requestFullscreen;

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);
    const [keyboardLocked, setKeyboardLocked] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);

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

    const handleAddPane = (role: PaneType) => layoutRef.current?.addPane(role);

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
