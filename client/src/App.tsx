import { useRef } from 'react';
import { MenuBar } from './MenuBar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';

type PaneType = 'neovim' | 'terminal' | 'explorer' | 'settings';

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);

    const handleAddPane = (role: PaneType) => layoutRef.current?.addPane(role);

    return (
        <>
            <MenuBar onAddPane={handleAddPane} />
            <LayoutContainer ref={layoutRef} />
        </>
    );
}
