export interface ThemeColors {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
    // UI chrome colors
    uiBackground: string;
    uiSurface: string;
    uiBorder: string;
    uiAccent: string;
    uiText: string;
    uiTextMuted: string;
    // SmartPane chrome colors
    paneBg: string;      // overall page background
    paneHeader: string;  // header bar background
    paneContent: string; // content area background
    paneBorder: string;  // border colour
}

export const THEMES: Record<string, ThemeColors> = {
    'mineo-dark': {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: '#264f78',
        black: '#1e1e2e', red: '#f55', green: '#89e051', yellow: '#e0c882',
        blue: '#5865f2', magenta: '#c678dd', cyan: '#56b6c2', white: '#cccccc',
        brightBlack: '#555555', brightRed: '#ff6b6b', brightGreen: '#98e06d',
        brightYellow: '#f0d89a', brightBlue: '#7b8af2', brightMagenta: '#d19de0',
        brightCyan: '#6dc9d3', brightWhite: '#ffffff',
        uiBackground: '#121212', uiSurface: '#2a2a2a', uiBorder: '#333333',
        uiAccent: '#60a5fa', uiText: '#e5e7eb', uiTextMuted: '#9ca3af',
        paneBg: '#121212', paneHeader: '#2a2a2a', paneContent: '#1e1e1e', paneBorder: '#333333',
    },
    'one-dark': {
        background: '#282c34',
        foreground: '#abb2bf',
        cursor: '#528bff',
        selectionBackground: '#3e4451',
        black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#d19a66',
        blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
        brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
        brightYellow: '#d19a66', brightBlue: '#61afef', brightMagenta: '#c678dd',
        brightCyan: '#56b6c2', brightWhite: '#ffffff',
        uiBackground: '#21252b', uiSurface: '#2c313a', uiBorder: '#3e4451',
        uiAccent: '#61afef', uiText: '#abb2bf', uiTextMuted: '#5c6370',
        paneBg: '#1a1d23', paneHeader: '#2c313a', paneContent: '#282c34', paneBorder: '#3e4451',
    },
    'dracula': {
        background: '#282a36',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        selectionBackground: '#44475a',
        black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
        blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
        brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
        brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
        brightCyan: '#a4ffff', brightWhite: '#ffffff',
        uiBackground: '#1e1f29', uiSurface: '#2d2f3f', uiBorder: '#44475a',
        uiAccent: '#bd93f9', uiText: '#f8f8f2', uiTextMuted: '#6272a4',
        paneBg: '#1a1b24', paneHeader: '#2d2f3f', paneContent: '#282a36', paneBorder: '#44475a',
    },
    'monokai': {
        background: '#272822',
        foreground: '#f8f8f2',
        cursor: '#f8f8f0',
        selectionBackground: '#49483e',
        black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
        blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
        brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
        brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
        brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
        uiBackground: '#1e1f1c', uiSurface: '#2f2f2a', uiBorder: '#49483e',
        uiAccent: '#a6e22e', uiText: '#f8f8f2', uiTextMuted: '#75715e',
        paneBg: '#1a1b18', paneHeader: '#2f2f2a', paneContent: '#272822', paneBorder: '#49483e',
    },
};

export function getTheme(name: string): ThemeColors {
    return THEMES[name] ?? THEMES['mineo-dark'];
}

/** Apply theme as CSS custom properties on :root */
export function applyThemeCSS(theme: ThemeColors): void {
    const root = document.documentElement;
    root.style.setProperty('--ui-bg', theme.uiBackground);
    root.style.setProperty('--ui-surface', theme.uiSurface);
    root.style.setProperty('--ui-border', theme.uiBorder);
    root.style.setProperty('--ui-accent', theme.uiAccent);
    root.style.setProperty('--ui-text', theme.uiText);
    root.style.setProperty('--ui-text-muted', theme.uiTextMuted);
    root.style.setProperty('--term-bg', theme.background);

    // SmartPane chrome colors
    root.style.setProperty('--pane-bg', theme.paneBg);
    root.style.setProperty('--pane-header', theme.paneHeader);
    root.style.setProperty('--pane-content', theme.paneContent);
    root.style.setProperty('--pane-border', theme.paneBorder);
}

/** Convert theme to xterm ITheme */
export function toXtermTheme(theme: ThemeColors): Record<string, string> {
    return {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        selectionBackground: theme.selectionBackground,
        black: theme.black, red: theme.red, green: theme.green, yellow: theme.yellow,
        blue: theme.blue, magenta: theme.magenta, cyan: theme.cyan, white: theme.white,
        brightBlack: theme.brightBlack, brightRed: theme.brightRed,
        brightGreen: theme.brightGreen, brightYellow: theme.brightYellow,
        brightBlue: theme.brightBlue, brightMagenta: theme.brightMagenta,
        brightCyan: theme.brightCyan, brightWhite: theme.brightWhite,
    };
}
