# Monaco LSP + Treesitter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up monaco-languageclient + web-tree-sitter so Monaco mode has standalone LSP (completions, hover, diagnostics) and treesitter syntax highlighting for TypeScript, Python, Go, and Rust.

**Architecture:** Backend `LspServerManager` spawns language server child processes on demand and bridges each to a WebSocket endpoint (`/lsp/<lang>`). Frontend `LspClientManager` creates `MonacoLanguageClient` instances when Monaco mode is active. `TreesitterManager` loads grammar WASM files and registers `ITokensProvider` per language.

**Tech Stack:** `monaco-languageclient`, `vscode-languageclient`, `vscode-jsonrpc`, `web-tree-sitter`, `ws` (already in Theia), Theia's `MessagingService.Contribution`, TypeScript.

---

### Context: How the codebase is wired

- **Backend DI:** `app/src/node/mineo-backend-module.ts` — exports a `ContainerModule` that binds contributions. Adding a new `MessagingService.Contribution` is one `bind()` line at the bottom.
- **Frontend DI:** `app/src/browser/mineo-frontend-module.ts` — exports a `ContainerModule`. `ModeService` (already exists) fires `onModeChange` events and exposes `currentMode`.
- **Build:** `cd app && npm run build` (tsc → theia build → webpack). TypeScript source in `app/src/`, compiled to `app/lib/`.
- **Tests:** No existing test framework in this project. Steps below use manual smoke-test verification instead of automated tests.
- **Package installs:** Run `npm install <pkg>` from `app/` directory (not repo root).

---

### Task 1: Install backend dependencies

**Files:**
- Modify: `app/package.json`

**Step 1: Install vscode-jsonrpc on the backend**

```bash
cd app && npm install vscode-jsonrpc@8.2.0
```

Expected: `package.json` gains `"vscode-jsonrpc": "8.2.0"` in dependencies.

**Step 2: Verify import resolves**

```bash
cd app && node -e "require('vscode-jsonrpc'); console.log('ok')"
```

Expected: prints `ok`.

**Step 3: Commit**

```bash
cd app && git add package.json package-lock.json
git commit -m "feat(lsp): install vscode-jsonrpc for LSP stdio bridge"
```

---

### Task 2: Install frontend dependencies

**Files:**
- Modify: `app/package.json`

**Step 1: Install monaco-languageclient and web-tree-sitter**

```bash
cd app && npm install monaco-languageclient@8.4.0 vscode-languageclient@9.0.1 web-tree-sitter@0.22.6
```

Expected: all three appear in `app/package.json` dependencies.

**Step 2: Verify monaco-languageclient resolves**

```bash
cd app && node -e "require('monaco-languageclient'); console.log('ok')" 2>&1 | head -5
```

Expected: `ok` or a harmless browser-API error (it imports fine in the build pipeline).

**Step 3: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "feat(lsp): install monaco-languageclient and web-tree-sitter"
```

---

### Task 3: Download treesitter grammar WASM files

**Files:**
- Create directory: `app/static/grammars/`

**Step 1: Create the grammars directory**

```bash
mkdir -p app/static/grammars
```

**Step 2: Download grammar files**

These are prebuilt WASM files from the `tree-sitter` community.

```bash
cd app/static/grammars

# tree-sitter WASM runtime itself (needed by web-tree-sitter)
curl -L -o tree-sitter.wasm \
  https://github.com/tree-sitter/tree-sitter/releases/download/v0.22.6/tree-sitter.wasm

# TypeScript
curl -L -o tree-sitter-typescript.wasm \
  https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.21.0/tree-sitter-typescript.wasm

# Python
curl -L -o tree-sitter-python.wasm \
  https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.21.0/tree-sitter-python.wasm

# Go
curl -L -o tree-sitter-go.wasm \
  https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.21.0/tree-sitter-go.wasm

# Rust
curl -L -o tree-sitter-rust.wasm \
  https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.21.1/tree-sitter-rust.wasm
```

**Step 3: Verify files exist**

```bash
ls -lh app/static/grammars/
```

Expected: 5 `.wasm` files, each between 100KB–2MB.

**Step 4: Serve static grammars via webpack**

The webpack config copies static assets. Add to `app/webpack.config.js`:

```js
// app/webpack.config.js
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (config) => {
  config.plugins = config.plugins || [];
  config.plugins.push(
    new CopyPlugin({
      patterns: [
        { from: 'static/grammars', to: 'grammars' },
      ],
    })
  );
  return config;
};
```

Then install copy-webpack-plugin if needed:

```bash
cd app && npm install --save-dev copy-webpack-plugin
```

**Step 5: Commit**

```bash
git add app/static/grammars/ app/webpack.config.js app/package.json app/package-lock.json
git commit -m "feat(treesitter): add grammar WASM files and webpack copy"
```

---

### Task 4: Backend — LspServerManager

**Files:**
- Create: `app/src/node/lsp-server-manager.ts`
- Modify: `app/src/node/mineo-backend-module.ts`

**Step 1: Create `lsp-server-manager.ts`**

```typescript
// app/src/node/lsp-server-manager.ts
import { injectable } from '@theia/core/shared/inversify';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { spawn, ChildProcess } from 'child_process';
import * as WebSocket from 'ws';

/**
 * Maps language IDs to their language server CLI commands.
 * Language servers must be on PATH; missing ones return 404.
 */
const LSP_SERVERS: Record<string, string[]> = {
  typescript: ['typescript-language-server', '--stdio'],
  python:     ['pylsp'],
  go:         ['gopls'],
  rust:       ['rust-analyzer'],
};

/**
 * LspServerManager — spawns language servers on demand and bridges
 * each server's stdio to a WebSocket endpoint at /lsp/<lang>.
 *
 * One server process per language, reused across reconnects.
 * Registered as a MessagingService.Contribution so Theia starts it.
 */
@injectable()
export class LspServerManager implements MessagingService.Contribution {
  private servers = new Map<string, ChildProcess>();

  configure(service: MessagingService): void {
    for (const lang of Object.keys(LSP_SERVERS)) {
      // MessagingService.Contribution uses registerChannelHandler for
      // Theia channels, but LSP needs raw WebSocket. Use the underlying
      // httpServer to upgrade /lsp/<lang> manually.
    }
    // We register the HTTP upgrade handler in onStart instead, which
    // gives us access to the raw http.Server. See below.
  }
}
```

Wait — `MessagingService.Contribution` doesn't give direct access to the raw `http.Server` for custom WS upgrades. The right pattern (matching how Theia's own channels work) is to use `BackendApplicationContribution.onStart(server)` which receives the `http.Server`. Revise:

**Step 1 (revised): Create `lsp-server-manager.ts`**

```typescript
// app/src/node/lsp-server-manager.ts
import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as WebSocket from 'ws';

const LSP_SERVERS: Record<string, string[]> = {
  typescript: ['typescript-language-server', '--stdio'],
  python:     ['pylsp'],
  go:         ['gopls'],
  rust:       ['rust-analyzer'],
};

/**
 * LspServerManager — BackendApplicationContribution that:
 * 1. Intercepts HTTP upgrade requests for /lsp/<lang>
 * 2. Spawns the language server child process (once per lang, reused)
 * 3. Bridges WebSocket messages <-> language server stdio
 */
@injectable()
export class LspServerManager implements BackendApplicationContribution {
  private servers = new Map<string, ChildProcess>();
  private wss = new WebSocket.WebSocketServer({ noServer: true });

  onStart(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      const match = url.match(/^\/lsp\/(\w+)$/);
      if (!match) return; // not our request

      const lang = match[1];
      const cmd = LSP_SERVERS[lang];
      if (!cmd) {
        // Unknown language — reject with 404
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, lang, cmd);
      });
    });
  }

  private handleConnection(ws: WebSocket.WebSocket, lang: string, cmd: string[]): void {
    let proc = this.servers.get(lang);

    // Spawn language server if not running
    if (!proc || proc.exitCode !== null) {
      proc = this.spawnServer(lang, cmd);
    }

    // WebSocket → lang server stdin
    ws.on('message', (data) => {
      if (proc && proc.stdin && proc.exitCode === null) {
        proc.stdin.write(data instanceof Buffer ? data : Buffer.from(data as string));
      }
    });

    // Lang server stdout → WebSocket
    const onData = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    };
    proc.stdout!.on('data', onData);

    ws.on('close', () => {
      proc!.stdout!.off('data', onData);
      // Keep the server process alive for reconnects
    });
  }

  private spawnServer(lang: string, cmd: string[]): ChildProcess {
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      console.error(`[LspServerManager] ${lang} failed to start: ${err.message}`);
      this.servers.delete(lang);
    });

    proc.on('exit', (code) => {
      console.log(`[LspServerManager] ${lang} exited with code ${code}`);
      this.servers.delete(lang);
    });

    proc.stderr!.on('data', (d: Buffer) => {
      // Language servers write logs to stderr — swallow to avoid noise
      // Uncomment to debug: console.error(`[${lang}]`, d.toString());
    });

    this.servers.set(lang, proc);
    return proc;
  }
}
```

**Step 2: Register in backend module**

In `app/src/node/mineo-backend-module.ts`, add to the imports and the `ContainerModule`:

```typescript
// Add import at top:
import { LspServerManager } from './lsp-server-manager';

// Add to ContainerModule bind calls:
bind(BackendApplicationContribution).to(LspServerManager).inSingletonScope();
```

**Step 3: Build and verify it compiles**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors on the new files.

**Step 4: Commit**

```bash
git add app/src/node/lsp-server-manager.ts app/src/node/mineo-backend-module.ts
git commit -m "feat(lsp): add LspServerManager — spawns language servers on /lsp/<lang> WS"
```

---

### Task 5: Frontend — LspClientManager

**Files:**
- Create: `app/src/browser/lsp-client-manager.ts`
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Step 1: Create `lsp-client-manager.ts`**

```typescript
// app/src/browser/lsp-client-manager.ts
import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient';
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';

// ModeService is defined in mineo-frontend-module.ts in the same file.
// We import it by accessing the DI token directly — since it's not exported,
// we use a symbol. See registration note in Step 2.
import { ModeService } from './mineo-frontend-module';

const LANGUAGE_IDS: Record<string, string> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
};

// Maps Monaco language ID → our /lsp/<lang> endpoint key
const LANG_TO_ENDPOINT: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'typescript', // ts-server handles JS too
  python: 'python',
  go: 'go',
  rust: 'rust',
};

/**
 * LspClientManager — FrontendApplicationContribution that:
 * - Watches for mode changes (Neovim ↔ Monaco)
 * - In Monaco mode: creates a MonacoLanguageClient per language on file open
 * - On switch to Neovim mode: disposes all clients
 */
@injectable()
export class LspClientManager implements FrontendApplicationContribution {
  @inject(ModeService) protected readonly modeService!: ModeService;
  @inject(EditorManager) protected readonly editorManager!: EditorManager;

  private clients = new Map<string, MonacoLanguageClient>();
  private toDispose = new DisposableCollection();

  onStart(): void {
    // React to mode changes
    this.toDispose.push(
      this.modeService.onModeChange((mode) => {
        if (mode === 'neovim') {
          this.disposeAll();
        }
      })
    );

    // React to editors being opened
    this.toDispose.push(
      this.editorManager.onCreated((widget) => {
        if (this.modeService.currentMode === 'monaco') {
          const langId = widget.editor.document.languageId;
          const endpoint = LANG_TO_ENDPOINT[langId];
          if (endpoint && !this.clients.has(endpoint)) {
            this.startClient(endpoint).catch((e) =>
              console.warn(`[LspClientManager] Could not start ${endpoint}:`, e)
            );
          }
        }
      })
    );
  }

  private async startClient(lang: string): Promise<void> {
    const wsUrl = this.buildWsUrl(`/lsp/${lang}`);
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`WebSocket error for /lsp/${lang}`)));
    });

    const socket = toSocket(ws);
    const reader = new WebSocketMessageReader(socket);
    const writer = new WebSocketMessageWriter(socket);

    const client = new MonacoLanguageClient({
      name: `${lang} Language Client`,
      clientOptions: {
        documentSelector: [{ language: lang }],
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue }),
          closed: () => ({ action: CloseAction.DoNotRestart }),
        },
      },
      messageTransports: { reader, writer },
    });

    client.start();
    this.clients.set(lang, client);
  }

  private disposeAll(): void {
    for (const client of this.clients.values()) {
      client.stop().catch(() => {});
    }
    this.clients.clear();
  }

  private buildWsUrl(path: string): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${path}`;
  }

  onStop(): void {
    this.disposeAll();
    this.toDispose.dispose();
  }
}
```

**Important note on `ModeService` import:** `ModeService` is currently a private class inside `mineo-frontend-module.ts`. Before this task works, you need to export it. In `mineo-frontend-module.ts`, change:

```typescript
// Before:
@injectable()
class ModeService {

// After:
@injectable()
export class ModeService {
```

**Step 2: Register in frontend module**

In `app/src/browser/mineo-frontend-module.ts`, add:

```typescript
// Add import at top:
import { LspClientManager } from './lsp-client-manager';

// Add to ContainerModule bind calls:
bind(FrontendApplicationContribution).to(LspClientManager).inSingletonScope();
```

**Step 3: Build check**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add app/src/browser/lsp-client-manager.ts app/src/browser/mineo-frontend-module.ts
git commit -m "feat(lsp): add LspClientManager — connects Monaco to language servers in Monaco mode"
```

---

### Task 6: Frontend — TreesitterManager

**Files:**
- Create: `app/src/browser/treesitter-manager.ts`
- Modify: `app/src/browser/mineo-frontend-module.ts`

**Step 1: Create `treesitter-manager.ts`**

```typescript
// app/src/browser/treesitter-manager.ts
import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import Parser from 'web-tree-sitter';
import { ModeService } from './mineo-frontend-module';

interface GrammarConfig {
  wasmPath: string;
  tokenMap: Record<string, string>; // treesitter node type → Monaco token type
}

const GRAMMARS: Record<string, GrammarConfig> = {
  typescript: {
    wasmPath: '/grammars/tree-sitter-typescript.wasm',
    tokenMap: {
      comment: 'comment',
      string: 'string',
      number: 'number',
      keyword: 'keyword',
      identifier: 'identifier',
      type_identifier: 'type',
      property_identifier: 'variable',
    },
  },
  javascript: {
    wasmPath: '/grammars/tree-sitter-typescript.wasm', // ts parser handles JS
    tokenMap: {
      comment: 'comment',
      string: 'string',
      number: 'number',
      keyword: 'keyword',
      identifier: 'identifier',
    },
  },
  python: {
    wasmPath: '/grammars/tree-sitter-python.wasm',
    tokenMap: {
      comment: 'comment',
      string: 'string',
      integer: 'number',
      float: 'number',
      keyword: 'keyword',
      identifier: 'identifier',
      type: 'type',
    },
  },
  go: {
    wasmPath: '/grammars/tree-sitter-go.wasm',
    tokenMap: {
      comment: 'comment',
      interpreted_string_literal: 'string',
      raw_string_literal: 'string',
      int_literal: 'number',
      float_literal: 'number',
      keyword: 'keyword',
      identifier: 'identifier',
      type_identifier: 'type',
    },
  },
  rust: {
    wasmPath: '/grammars/tree-sitter-rust.wasm',
    tokenMap: {
      line_comment: 'comment',
      block_comment: 'comment',
      string_literal: 'string',
      integer_literal: 'number',
      float_literal: 'number',
      keyword: 'keyword',
      identifier: 'identifier',
      type_identifier: 'type',
    },
  },
};

/**
 * TreesitterManager — loads web-tree-sitter WASM and registers an
 * ITokensProvider per language that replaces Monaco's regex tokenizer
 * with treesitter-based tokenization.
 *
 * Active only in Monaco mode. Falls back to Monaco's built-in tokenizer
 * if WASM loading fails.
 */
@injectable()
export class TreesitterManager implements FrontendApplicationContribution {
  @inject(ModeService) protected readonly modeService!: ModeService;

  private initialized = false;
  private parsers = new Map<string, Parser>();
  private registrations = new Map<string, monaco.IDisposable>();

  async onStart(): Promise<void> {
    // Only initialize when in Monaco mode; lazy-init on mode switch too
    if (this.modeService.currentMode === 'monaco') {
      await this.initialize();
    }

    this.modeService.onModeChange(async (mode) => {
      if (mode === 'monaco' && !this.initialized) {
        await this.initialize();
      }
    });
  }

  private async initialize(): Promise<void> {
    try {
      await Parser.init({
        locateFile: () => '/grammars/tree-sitter.wasm',
      });

      for (const [lang, config] of Object.entries(GRAMMARS)) {
        await this.registerLanguage(lang, config);
      }

      this.initialized = true;
    } catch (e) {
      console.warn('[TreesitterManager] WASM init failed, falling back to Monaco tokenizer:', e);
    }
  }

  private async registerLanguage(lang: string, config: GrammarConfig): Promise<void> {
    try {
      const langObj = await Parser.Language.load(config.wasmPath);
      const parser = new Parser();
      parser.setLanguage(langObj);
      this.parsers.set(lang, parser);

      const tokenProvider: monaco.languages.ITokensProvider = {
        getInitialState: () => ({ clone: () => ({ clone: () => ({}), equals: () => true }), equals: () => true }),
        tokenize: (line, state) => {
          const p = this.parsers.get(lang)!;
          const tree = p.parse(line);
          const tokens: monaco.languages.IToken[] = [];

          const walk = (node: Parser.SyntaxNode) => {
            if (!node.isNamed) {
              for (const child of node.children) walk(child);
              return;
            }
            const monacoType = config.tokenMap[node.type];
            if (monacoType && node.startIndex < line.length) {
              tokens.push({ startIndex: node.startIndex, scopes: monacoType });
            }
            for (const child of node.children) walk(child);
          };

          walk(tree.rootNode);
          tokens.sort((a, b) => a.startIndex - b.startIndex);

          return { tokens, endState: state };
        },
      };

      const reg = monaco.languages.setTokensProvider(lang, tokenProvider);
      this.registrations.set(lang, reg);
    } catch (e) {
      console.warn(`[TreesitterManager] Failed to load ${lang} grammar, using Monaco fallback:`, e);
    }
  }
}
```

**Step 2: Register in frontend module**

In `app/src/browser/mineo-frontend-module.ts`:

```typescript
// Add import:
import { TreesitterManager } from './treesitter-manager';

// Add bind:
bind(FrontendApplicationContribution).to(TreesitterManager).inSingletonScope();
```

**Step 3: Build check**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add app/src/browser/treesitter-manager.ts app/src/browser/mineo-frontend-module.ts
git commit -m "feat(treesitter): add TreesitterManager — WASM-based syntax highlighting in Monaco mode"
```

---

### Task 7: Full build and smoke test

**Step 1: Full build**

```bash
cd app && npm run build
```

Expected: exits 0, no TypeScript errors, webpack bundle produced.

**Step 2: Start the server**

```bash
node app/lib/backend/main.js
```

Or use the project's existing start script:

```bash
node scripts/start.js
```

**Step 3: Open browser and switch to Monaco mode**

Navigate to `http://localhost:3000`. Click the mode toggle in the status bar to switch to Monaco mode.

**Step 4: Verify LSP**

Open a `.ts` file. Wait 2–3 seconds. Verify:
- Hover over a variable → tooltip appears with type info
- Type a partial identifier → completion dropdown appears
- Introduce a type error → red squiggle appears

**Step 5: Verify treesitter**

With the `.ts` file open in Monaco mode, verify syntax highlighting is present (keywords, strings, comments have colors).

**Step 6: Verify fallback behavior**

Stop `rust-analyzer` (or ensure it's not installed). Open a `.rs` file. Verify no crash, Monaco still works, just no LSP features.

**Step 7: Verify mode switch**

Switch back to Neovim mode. Verify Neovim terminal appears, Monaco LSP clients disconnected (check browser network tab — `/lsp/*` WebSocket connections closed).

**Step 8: Commit if any fixups were needed**

```bash
git add -p
git commit -m "fix(lsp): <describe any fixup>"
```

---

### Task 8: Handle WebSocket import for Node.js backend

**Context:** `app/src/node/lsp-server-manager.ts` imports `ws` as `WebSocket`. Theia's backend already has `ws` as a transitive dependency, but we need the types.

**Step 1: Add ws types**

```bash
cd app && npm install --save-dev @types/ws
```

**Step 2: Fix the import in lsp-server-manager.ts**

```typescript
// Replace:
import * as WebSocket from 'ws';

// With (if the above causes issues with esModuleInterop):
import WebSocket, { WebSocketServer } from 'ws';
// and use WebSocketServer directly instead of new WebSocket.WebSocketServer(...)
```

**Step 3: Build check**

```bash
cd app && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add app/src/node/lsp-server-manager.ts app/package.json app/package-lock.json
git commit -m "fix(lsp): add @types/ws, fix WebSocket import in LspServerManager"
```

---

### Execution order note

Tasks 1 and 2 (npm installs) can be done together. Task 8 (ws types) should be done alongside Task 4 if TypeScript errors appear about `ws`. Tasks 4 and 5 are independent and can be done in parallel. Task 6 depends on `ModeService` export (done in Task 5). Task 7 is always last.

Recommended order: 1 → 2 → 3 → 4+8 → 5 → 6 → 7
