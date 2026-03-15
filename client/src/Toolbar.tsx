interface Props {
    onAdd: (role: 'neovim' | 'terminal' | 'explorer') => void;
}

export function Toolbar({ onAdd }: Props) {
    return (
        <div className="mineo-toolbar">
            <button className="mineo-toolbar-btn" onClick={() => onAdd('neovim')}>+ Neovim</button>
            <button className="mineo-toolbar-btn" onClick={() => onAdd('terminal')}>+ Terminal</button>
            <button className="mineo-toolbar-btn" onClick={() => onAdd('explorer')}>+ Explorer</button>
        </div>
    );
}
