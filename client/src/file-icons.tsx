/** Icon descriptor returned by getFileIcon / getOpenFolderIcon */
export interface FileIcon {
    /** devicon CSS class e.g. "devicon-typescript-plain colored" — null means use svg */
    deviconClass: string | null;
    /** inline SVG string — used only when deviconClass is null */
    svg: string | null;
    /** colour applied to svg icons */
    color: string;
}

/* ── Lucide SVG paths for folder / generic file ── */
// folder (closed)
const SVG_FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
// folder-open
const SVG_FOLDER_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><polyline points="2 10 12 10 22 10"/></svg>`;
// generic file
const SVG_FILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;

/* ── devicon map by extension ── */
const DEVICON_EXT: Record<string, string> = {
    // TypeScript / JavaScript
    ts:         'devicon-typescript-plain colored',
    tsx:        'devicon-typescript-plain colored',
    js:         'devicon-javascript-plain colored',
    jsx:        'devicon-react-original colored',
    mjs:        'devicon-javascript-plain colored',
    cjs:        'devicon-javascript-plain colored',

    // Web
    html:       'devicon-html5-plain colored',
    css:        'devicon-css3-plain colored',
    scss:       'devicon-sass-plain colored',
    sass:       'devicon-sass-plain colored',
    less:       'devicon-less-plain colored',
    vue:        'devicon-vuejs-plain colored',
    svelte:     'devicon-svelte-plain colored',

    // Data / Config
    json:       'devicon-json-plain colored',

    // Languages
    py:         'devicon-python-plain colored',
    rb:         'devicon-ruby-plain colored',
    go:         'devicon-go-plain colored',
    rs:         'devicon-rust-plain colored',
    java:       'devicon-java-plain colored',
    kt:         'devicon-kotlin-plain colored',
    scala:      'devicon-scala-plain colored',
    c:          'devicon-c-plain colored',
    cpp:        'devicon-cplusplus-plain colored',
    cc:         'devicon-cplusplus-plain colored',
    h:          'devicon-c-plain colored',
    hpp:        'devicon-cplusplus-plain colored',
    cs:         'devicon-csharp-plain colored',
    swift:      'devicon-swift-plain colored',
    dart:       'devicon-dart-plain colored',
    php:        'devicon-php-plain colored',
    lua:        'devicon-lua-plain colored',
    zig:        'devicon-zig-plain colored',
    r:          'devicon-r-plain colored',

    // Shell
    sh:         'devicon-bash-plain colored',
    bash:       'devicon-bash-plain colored',
    zsh:        'devicon-bash-plain colored',
    fish:       'devicon-bash-plain colored',

    // Markup / Docs
    md:         'devicon-markdown-plain colored',
    mdx:        'devicon-markdown-plain colored',

    // Build / Tooling
    dockerfile: 'devicon-docker-plain colored',

    // Vim / Neovim
    vim:        'devicon-vim-plain colored',

    // GraphQL
    graphql:    'devicon-graphql-plain colored',
    gql:        'devicon-graphql-plain colored',

    // Git
    gitignore:  'devicon-git-plain colored',
    gitmodules: 'devicon-git-plain colored',
};

/* ── devicon map by special filename ── */
const DEVICON_FILENAME: Record<string, string> = {
    'dockerfile':              'devicon-docker-plain colored',
    'docker-compose.yml':      'devicon-docker-plain colored',
    'docker-compose.yaml':     'devicon-docker-plain colored',
    '.gitignore':              'devicon-git-plain colored',
    '.gitmodules':             'devicon-git-plain colored',
    '.gitattributes':          'devicon-git-plain colored',
    'package.json':            'devicon-npm-plain colored',
    'package-lock.json':       'devicon-npm-plain colored',
    'yarn.lock':               'devicon-yarn-plain colored',
    'tsconfig.json':           'devicon-typescript-plain colored',
    'tsconfig.base.json':      'devicon-typescript-plain colored',
    'webpack.config.js':       'devicon-webpack-plain colored',
    'webpack.config.ts':       'devicon-webpack-plain colored',
    'vite.config.ts':          'devicon-vitejs-plain colored',
    'vite.config.js':          'devicon-vitejs-plain colored',
    'tailwind.config.js':      'devicon-tailwindcss-plain colored',
    'tailwind.config.ts':      'devicon-tailwindcss-plain colored',
    '.eslintrc':               'devicon-eslint-plain colored',
    '.eslintrc.js':            'devicon-eslint-plain colored',
    '.eslintrc.json':          'devicon-eslint-plain colored',
    'go.mod':                  'devicon-go-plain colored',
    'go.sum':                  'devicon-go-plain colored',
    'cargo.toml':              'devicon-rust-plain colored',
    'cargo.lock':              'devicon-rust-plain colored',
    'requirements.txt':        'devicon-python-plain colored',
    'pyproject.toml':          'devicon-python-plain colored',
    'gemfile':                 'devicon-ruby-plain colored',
    'makefile':                'devicon-bash-plain colored',
    'readme.md':               'devicon-markdown-plain colored',
    '.nvmrc':                  'devicon-nodejs-plain colored',
    '.node-version':           'devicon-nodejs-plain colored',
};

function di(cls: string): FileIcon {
    return { deviconClass: cls, svg: null, color: '' };
}

export function getFileIcon(
    extension: string | undefined,
    isDirectory: boolean,
    filename?: string,
): FileIcon {
    if (isDirectory) {
        return { deviconClass: null, svg: SVG_FOLDER, color: '#c09553' };
    }

    // Special filenames first
    if (filename) {
        const lower = filename.toLowerCase();
        const cls = DEVICON_FILENAME[lower];
        if (cls) return di(cls);
    }

    const ext = (extension ?? '').toLowerCase();
    const cls = DEVICON_EXT[ext];
    if (cls) return di(cls);

    // Generic file fallback
    return { deviconClass: null, svg: SVG_FILE, color: '#6d8086' };
}

export function getOpenFolderIcon(): FileIcon {
    return { deviconClass: null, svg: SVG_FOLDER_OPEN, color: '#c09553' };
}
