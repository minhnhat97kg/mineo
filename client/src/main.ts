import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './style/main.css';
import { LayoutManager } from './layout-manager';

document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('mineo-root')!;
    const manager = new LayoutManager(root);

    const toolbar = document.createElement('div');
    toolbar.className = 'mineo-toolbar';

    const mkBtn = (label: string, action: () => void) => {
        const b = document.createElement('button');
        b.className = 'mineo-toolbar-btn';
        b.textContent = label;
        b.addEventListener('click', action);
        toolbar.appendChild(b);
    };

    mkBtn('+ Neovim', () => manager.addPane('neovim'));
    mkBtn('+ Terminal', () => manager.addPane('terminal'));

    document.body.appendChild(toolbar);
});
