# Monaco LSP + Treesitter Design

**Date:** 2026-03-13
**Status:** Approved

## Goal

When the user is in Monaco mode, provide a fully standalone language stack with:
- LSP-powered completions, hover, and diagnostics for TypeScript, Python, Go, and Rust
- Treesitter-based syntax highlighting for the same four languages

The Neovim process and vscode-neovim extension are unaffected. LSP and treesitter are active only in Monaco mode.

## Architecture

```
Browser (Monaco mode)
  └── monaco-languageclient (LSP client, per language)
        │ WebSocket JSON-RPC  (/lsp/<lang>)
        ▼
Theia Backend (Node.js)
  └── LspServerManager
        ├── typescript-language-server  (stdio)
        ├── pylsp / pyright             (stdio)
        ├── gopls                       (stdio)
        └── rust-analyzer               (stdio)

Browser (Monaco mode)
  └── web-tree-sitter (WASM)
        └── ITokensProvider registered per language grammar
```

## Components

### Backend: `LspServerManager`
**File:** `app/src/node/lsp-server-manager.ts`

- Spawns/kills language server child processes on demand (lazy — only when a file of that language is opened)
- One process per language, reused across files
- Registers a WebSocket endpoint per language: `/lsp/typescript`, `/lsp/python`, `/lsp/go`, `/lsp/rust`
- Pipes WebSocket messages ↔ language server stdio using `vscode-jsonrpc`
- Registered as a `MessagingService.Contribution` alongside the existing PTY contributions

### Frontend: `LspClientManager`
**File:** `app/src/browser/lsp-client-manager.ts`

- Activates only when `ModeService.mode === 'monaco'`
- Creates one `MonacoLanguageClient` per language when a file of that type is opened
- Connects via WebSocket to `/lsp/<lang>` on the backend
- Disposes clients when switching to Neovim mode

### Frontend: `TreesitterManager`
**File:** `app/src/browser/treesitter-manager.ts`

- Loads `web-tree-sitter` WASM once on startup
- Downloads grammar WASM files for TS, Python, Go, Rust (bundled in `app/static/grammars/`)
- Registers a `monaco.languages.ITokensProvider` per language using treesitter tokenization
- Active in Monaco mode only

## Data Flow

### LSP (file open → completion)
1. User opens file in Monaco mode → `LspClientManager` detects language, connects WebSocket to `/lsp/<lang>`
2. Backend `LspServerManager` spawns language server if not running, bridges WebSocket ↔ stdio
3. `monaco-languageclient` sends `textDocument/didOpen` → language server initializes
4. Monaco requests completions → client sends `textDocument/completion` → server responds → Monaco shows dropdown
5. Diagnostics pushed via `textDocument/publishDiagnostics` → Monaco underlines errors

### Treesitter (syntax highlighting)
1. On Monaco mode activation, `TreesitterManager` loads WASM parser + grammars
2. `ITokensProvider.tokenize()` called per line → treesitter parses → returns token array mapped to Monaco theme scopes
3. Re-tokenizes incrementally on edit

### Mode switching
- **Neovim → Monaco:** `LspClientManager` starts, `TreesitterManager` activates providers
- **Monaco → Neovim:** clients disposed, WebSocket connections closed, language servers stay running (reused on next switch)

## Error Handling

- **Language server crash:** `LspServerManager` logs error, removes from active map; client reconnects on next file open
- **Language server not installed:** backend returns HTTP 404 on `/lsp/<lang>` WebSocket upgrade; `LspClientManager` silently skips, Monaco built-in tokenizer used as fallback
- **WASM load failure:** `TreesitterManager` catches error, falls back to Monaco's built-in tokenizer for that language

## Dependencies

New packages required:
- `monaco-languageclient` — LSP client for Monaco
- `vscode-languageclient` — LSP protocol types
- `vscode-jsonrpc` — JSON-RPC over stdio/WebSocket
- `web-tree-sitter` — Treesitter WASM runtime
- Tree-sitter grammar WASM files for TS, Python, Go, Rust (bundled as static assets)

Language servers (must be on PATH, not auto-installed):
- `typescript-language-server`
- `pylsp` or `pyright`
- `gopls`
- `rust-analyzer`

## Out of Scope

- Multi-root workspace LSP (Mineo is single-root only)
- LSP in Neovim mode (Neovim's own `nvim-lspconfig` handles that)
- Automatic language server installation
- Treesitter in Neovim mode
