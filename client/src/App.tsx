import { useRef, useState } from 'react';
import { MenuBar } from './MenuBar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';
import { ReconnectOverlay } from './ReconnectOverlay';

type PaneType = 'neovim' | 'terminal' | 'explorer' | 'settings';

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);
    const [keyboardLocked, setKeyboardLocked] = useState(true);

    const handleAddPane = (role: PaneType) => layoutRef.current?.addPane(role);

    return (
        <>
            <MenuBar
                onAddPane={handleAddPane}
                keyboardLocked={keyboardLocked}
                onToggleKeyboard={() => setKeyboardLocked(v => !v)}
            />
            <LayoutContainer ref={layoutRef} keyboardLocked={keyboardLocked} />
            <ReconnectOverlay />
        </>
    );
}
