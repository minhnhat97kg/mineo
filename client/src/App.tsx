import { useRef } from 'react';
import { Toolbar } from './Toolbar';
import { LayoutContainer, LayoutContainerHandle } from './LayoutContainer';
import type { PaneRole } from './pty-control-service';

export function App() {
    const layoutRef = useRef<LayoutContainerHandle>(null);

    const handleAdd = (role: PaneRole) => layoutRef.current?.addPane(role);

    return (
        <>
            <Toolbar onAdd={handleAdd} />
            <LayoutContainer ref={layoutRef} />
        </>
    );
}
