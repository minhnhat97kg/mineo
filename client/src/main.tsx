import 'flexlayout-react/style/dark.css';
import 'xterm/css/xterm.css';
import 'devicon/devicon.min.css';
import './style/main.css';
import './style/explorer.css';
import './style/menubar.css';
import './style/settings.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installTouchToMouse } from './touch-to-mouse';

const rootEl = document.getElementById('mineo-root')!;
document.addEventListener('contextmenu', e => {
    // Allow the native long-press context menu inside xterm panes
    if (e.target instanceof Element && e.target.closest('.xterm')) return;
    e.preventDefault();
});
installTouchToMouse();
createRoot(rootEl).render(<App />);
