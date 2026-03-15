import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './style/main.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('mineo-root')!;
createRoot(rootEl).render(<App />);
