/**
 * LspClientManager — connects to language servers over WebSocket and registers
 * Monaco language providers for hover, completion, and go-to-definition.
 *
 * Architecture:
 *   Backend (LspServerManager): spawns gopls / pylsp / rust-analyzer on demand,
 *     bridges their stdio as raw bytes over WebSocket at /lsp/<lang>.
 *   Frontend (here): connects, speaks JSON-RPC (Content-Length framing),
 *     handles LSP initialize handshake, then registers monaco.languages providers.
 *
 * Why NOT MonacoLanguageClient / vscode-languageclient:
 *   Both require 'vscode' at import time. In the browser bundle there is no
 *   vscode module — it only exists inside the plugin-host. Using them here
 *   causes an immediate "Cannot find module 'vscode'" crash at bundle load.
 *
 * Why NOT Theia's plugin API for Go/Python/Rust:
 *   Each language would need a VSCode extension that bundles its language server.
 *   Mineo's model is simpler: language servers are installed on the host PATH,
 *   and the WebSocket bridge (LspServerManager) connects to them.
 *
 * This implementation speaks LSP directly using raw JSON-RPC over WebSocket,
 * with Content-Length framing and monaco.languages.* for provider registration.
 */

import { injectable, inject, LazyServiceIdentifier } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import * as monaco from '@theia/monaco-editor-core';
import { ModeService } from './mode-service';

// ── Language → LSP endpoint mapping ──────────────────────────────────────────

const LANG_ENDPOINT: Record<string, string> = {
    typescript:      'typescript',
    typescriptreact: 'typescript',
    javascript:      'typescript',
    javascriptreact: 'typescript',
    python:          'python',
    go:              'go',
    rust:            'rust',
};

// ── JSON-RPC / LSP framing ────────────────────────────────────────────────────

const HEADER_SEP = '\r\n\r\n';
const CONTENT_LENGTH = 'Content-Length: ';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeMessage(msg: object): ArrayBuffer {
    const body = JSON.stringify(msg);
    const header = `${CONTENT_LENGTH}${encoder.encode(body).length}${HEADER_SEP}`;
    const hBytes = encoder.encode(header);
    const bBytes = encoder.encode(body);
    const buf = new Uint8Array(hBytes.length + bBytes.length);
    buf.set(hBytes);
    buf.set(bBytes, hBytes.length);
    return buf.buffer;
}

/**
 * Incremental Content-Length frame parser.
 * Language servers emit: "Content-Length: N\r\n\r\n{json}"
 * Multiple messages can arrive in one WebSocket message, or a message can be split.
 */
class LspFramer {
    private _buf = new Uint8Array(0);

    push(chunk: Uint8Array): object[] {
        // Append chunk
        const merged = new Uint8Array(this._buf.length + chunk.length);
        merged.set(this._buf);
        merged.set(chunk, this._buf.length);
        this._buf = merged;

        const msgs: object[] = [];
        while (true) {
            const raw = decoder.decode(this._buf);
            const sepIdx = raw.indexOf(HEADER_SEP);
            if (sepIdx === -1) break;

            const header = raw.slice(0, sepIdx);
            const clEntry = header.split('\r\n').find(l => l.startsWith(CONTENT_LENGTH));
            if (!clEntry) break;

            const contentLength = parseInt(clEntry.slice(CONTENT_LENGTH.length), 10);
            if (isNaN(contentLength)) break;

            // Measure byte offset of body start (header is ASCII, so char == byte here)
            const headerBytes = encoder.encode(raw.slice(0, sepIdx + HEADER_SEP.length));
            const totalNeeded = headerBytes.length + contentLength;
            if (this._buf.length < totalNeeded) break;

            const bodyBytes = this._buf.slice(headerBytes.length, totalNeeded);
            const bodyStr = decoder.decode(bodyBytes);
            this._buf = this._buf.slice(totalNeeded);

            try {
                msgs.push(JSON.parse(bodyStr));
            } catch {
                // malformed JSON — skip
            }
        }
        return msgs;
    }
}

// ── LSP session ───────────────────────────────────────────────────────────────

let _nextId = 1;
function nextId(): number { return _nextId++; }

interface PendingRequest {
    resolve(result: unknown): void;
    reject(err: Error): void;
}

type LspMessage = {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
};

/**
 * Minimal LSP session over a WebSocket.
 * - Sends/receives JSON-RPC frames with Content-Length headers.
 * - Handles initialize handshake.
 * - Exposes sendRequest() / sendNotification().
 * - Fires onNotification for server-sent notifications (e.g. diagnostics).
 */
class LspSession implements Disposable {
    private readonly _ws: WebSocket;
    private readonly _framer = new LspFramer();
    private readonly _pending = new Map<number, PendingRequest>();
    private readonly _notifHandlers: Array<(method: string, params: unknown) => void> = [];
    private _disposed = false;
    private _ready = false;

    readonly onDispose: Promise<void>;
    private _onDisposeResolve!: () => void;

    constructor(ws: WebSocket) {
        this._ws = ws;
        this.onDispose = new Promise(res => { this._onDisposeResolve = res; });

        ws.binaryType = 'arraybuffer';

        ws.addEventListener('message', (ev: MessageEvent) => {
            let bytes: Uint8Array;
            if (ev.data instanceof ArrayBuffer) {
                bytes = new Uint8Array(ev.data);
            } else if (typeof ev.data === 'string') {
                bytes = encoder.encode(ev.data);
            } else return;

            for (const msg of this._framer.push(bytes)) {
                this._handleMessage(msg as LspMessage);
            }
        });

        ws.addEventListener('close', () => this.dispose());
        ws.addEventListener('error', () => this.dispose());
    }

    get isReady(): boolean { return this._ready; }

    private _handleMessage(msg: LspMessage): void {
        if (msg.id !== undefined && !msg.method) {
            // Response to one of our requests
            const pending = this._pending.get(msg.id);
            if (!pending) return;
            this._pending.delete(msg.id);
            if (msg.error) {
                pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
            } else {
                pending.resolve(msg.result);
            }
        } else if (msg.method) {
            // Server-initiated notification or request
            // If the server sends a request (has id + method), reply with no-op
            if (msg.id !== undefined) {
                this._send({ jsonrpc: '2.0', id: msg.id, result: null });
            }
            for (const h of this._notifHandlers) h(msg.method, msg.params);
        }
    }

    onNotification(handler: (method: string, params: unknown) => void): Disposable {
        this._notifHandlers.push(handler);
        return Disposable.create(() => {
            const i = this._notifHandlers.indexOf(handler);
            if (i >= 0) this._notifHandlers.splice(i, 1);
        });
    }

    sendRequest<T>(method: string, params: unknown): Promise<T> {
        const id = nextId();
        return new Promise<T>((resolve, reject) => {
            this._pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
            this._send({ jsonrpc: '2.0', id, method, params });
        });
    }

    sendNotification(method: string, params: unknown): void {
        this._send({ jsonrpc: '2.0', method, params });
    }

    private _send(msg: object): void {
        if (this._disposed || this._ws.readyState !== WebSocket.OPEN) return;
        this._ws.send(encodeMessage(msg));
    }

    async initialize(rootUri: string, workspaceFolders: Array<{ uri: string; name: string }>): Promise<void> {
        await this.sendRequest('initialize', {
            processId: null,
            rootUri,
            rootPath: rootUri.replace(/^file:\/\//, ''),
            workspaceFolders,
            capabilities: {
                textDocument: {
                    synchronization: {
                        dynamicRegistration: false,
                        willSave: false,
                        willSaveWaitUntil: false,
                        didSave: false,
                    },
                    hover: {
                        dynamicRegistration: false,
                        contentFormat: ['markdown', 'plaintext'],
                    },
                    completion: {
                        dynamicRegistration: false,
                        completionItem: {
                            snippetSupport: false,
                            documentationFormat: ['markdown', 'plaintext'],
                        },
                    },
                    definition: { dynamicRegistration: false },
                    publishDiagnostics: { relatedInformation: false },
                },
                workspace: {
                    workspaceFolders: true,
                    didChangeConfiguration: { dynamicRegistration: false },
                },
            },
        });
        this.sendNotification('initialized', {});
        this._ready = true;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._ready = false;
        for (const p of this._pending.values()) {
            p.reject(new Error('LSP session closed'));
        }
        this._pending.clear();
        if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
            this._ws.close();
        }
        this._onDisposeResolve();
    }
}

// ── Monaco provider registration ──────────────────────────────────────────────

/** Convert LSP Range → monaco.Range */
function toMonacoRange(r: {
    start: { line: number; character: number };
    end: { line: number; character: number };
}): monaco.Range {
    return new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
}

/** Convert monaco.Position → LSP Position */
function toLspPos(p: monaco.Position): { line: number; character: number } {
    return { line: p.lineNumber - 1, character: p.column - 1 };
}

/**
 * Convert a Monaco model URI to the LSP document URI.
 *
 * Theia opens files as file:// URIs but the monaco URI object stringifies to
 * the same form.  We normalise to ensure a clean file:// string is sent to
 * the language server so it can map the URI back to a filesystem path.
 */
function modelToLspUri(model: monaco.editor.ITextModel): string {
    return model.uri.toString();
}

function registerProviders(
    session: LspSession,
    lang: string,
    openDocs: Map<string, number>,   // uri → version
    toDispose: DisposableCollection,
): void {
    // Match both 'file' and any other scheme Theia may use (e.g. 'theia-resource')
    // so providers activate regardless of how the model was created.
    const selector = [{ language: lang }];

    // ── textDocument sync helpers ─────────────────────────────────────────────

    function syncOpen(model: monaco.editor.ITextModel): void {
        const uri = modelToLspUri(model);
        if (openDocs.has(uri)) return;
        openDocs.set(uri, model.getVersionId());
        session.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId: model.getLanguageId(),
                version: model.getVersionId(),
                text: model.getValue(),
            },
        });
    }

    function syncChange(model: monaco.editor.ITextModel): void {
        const uri = modelToLspUri(model);
        if (!openDocs.has(uri)) {
            syncOpen(model);
            return;
        }
        const version = model.getVersionId();
        openDocs.set(uri, version);
        session.sendNotification('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text: model.getValue() }],
        });
    }

    function syncClose(model: monaco.editor.ITextModel): void {
        const uri = modelToLspUri(model);
        if (!openDocs.has(uri)) return;
        openDocs.delete(uri);
        session.sendNotification('textDocument/didClose', {
            textDocument: { uri },
        });
    }

    // Sync all already-open models for this language
    for (const model of monaco.editor.getModels()) {
        if (LANG_ENDPOINT[model.getLanguageId()] === LANG_ENDPOINT[lang]) {
            syncOpen(model);
        }
    }

    // Watch for new models
    toDispose.push(monaco.editor.onDidCreateModel(model => {
        if (!session.isReady) return;
        if (LANG_ENDPOINT[model.getLanguageId()] === LANG_ENDPOINT[lang]) {
            syncOpen(model);
        }
    }));

    // Watch for content changes on existing and future editors.
    // onDidChangeModelContent is on the editor instance, not the namespace,
    // so we subscribe via onDidCreateEditor for editors created after our
    // session starts and iterate current editors for already-open ones.
    function attachChangeListener(editor: monaco.editor.ICodeEditor): void {
        const editorDisposable = editor.onDidChangeModelContent(() => {
            if (!session.isReady) return;
            const model = editor.getModel();
            if (!model) return;
            if (LANG_ENDPOINT[model.getLanguageId()] === LANG_ENDPOINT[lang]) {
                syncChange(model);
            }
        });
        toDispose.push(editorDisposable);
    }

    // Attach to already-open editors
    for (const editor of monaco.editor.getEditors()) {
        attachChangeListener(editor);
    }

    // Attach to future editors
    toDispose.push(monaco.editor.onDidCreateEditor(editor => {
        attachChangeListener(editor);
    }));

    // Watch for model disposal
    toDispose.push(monaco.editor.onWillDisposeModel(model => {
        if (LANG_ENDPOINT[model.getLanguageId()] === LANG_ENDPOINT[lang]) {
            syncClose(model);
        }
    }));

    // ── Hover ─────────────────────────────────────────────────────────────────
    toDispose.push(
        monaco.languages.registerHoverProvider(selector, {
            async provideHover(model, position) {
                if (!session.isReady) return undefined;
                syncOpen(model);
                const result = await session.sendRequest<{
                    contents: unknown;
                    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
                } | null>('textDocument/hover', {
                    textDocument: { uri: modelToLspUri(model) },
                    position: toLspPos(position),
                }).catch(() => null);

                if (!result) return undefined;

                let value = '';
                const c = result.contents;
                if (typeof c === 'string') {
                    value = c;
                } else if (c && typeof c === 'object' && 'value' in c) {
                    value = (c as { value: string }).value;
                } else if (Array.isArray(c)) {
                    value = c.map((x: unknown) =>
                        typeof x === 'string' ? x : (x as { value?: string })?.value ?? ''
                    ).filter(Boolean).join('\n\n');
                }

                if (!value) return undefined;

                return {
                    contents: [{ value, isTrusted: false }],
                    range: result.range ? toMonacoRange(result.range) : undefined,
                };
            },
        }) as Disposable
    );

    // ── Completion ────────────────────────────────────────────────────────────
    toDispose.push(
        monaco.languages.registerCompletionItemProvider(selector, {
            triggerCharacters: ['.', ':', '"', "'", '/', '@', '<'],
            async provideCompletionItems(model, position) {
                if (!session.isReady) return undefined;
                syncOpen(model);

                type LspCompletionItem = {
                    label: string;
                    kind?: number;
                    detail?: string;
                    documentation?: string | { value: string };
                    insertText?: string;
                    insertTextFormat?: number;
                    textEdit?: {
                        newText: string;
                        range: {
                            start: { line: number; character: number };
                            end: { line: number; character: number };
                        };
                    };
                };

                const result = await session.sendRequest<{
                    items?: LspCompletionItem[];
                    isIncomplete?: boolean;
                } | LspCompletionItem[] | null>('textDocument/completion', {
                    textDocument: { uri: modelToLspUri(model) },
                    position: toLspPos(position),
                    context: { triggerKind: 1 },
                }).catch(() => null);

                if (!result) return undefined;
                const raw = Array.isArray(result) ? result : (result.items ?? []);
                const items: LspCompletionItem[] = raw;

                const word = model.getWordUntilPosition(position);
                const replaceRange = new monaco.Range(
                    position.lineNumber, word.startColumn,
                    position.lineNumber, word.endColumn,
                );

                return {
                    suggestions: items.map(item => {
                        const docStr = typeof item.documentation === 'string'
                            ? item.documentation
                            : item.documentation?.value ?? '';
                        const insertText = item.textEdit?.newText ?? item.insertText ?? item.label;
                        const range = item.textEdit?.range ? toMonacoRange(item.textEdit.range) : replaceRange;
                        return {
                            label: item.label,
                            kind: (item.kind ?? 1) as monaco.languages.CompletionItemKind,
                            detail: item.detail,
                            documentation: docStr ? { value: docStr } : undefined,
                            insertText,
                            range,
                        };
                    }),
                    incomplete: Array.isArray(result) ? false : (result.isIncomplete ?? false),
                };
            },
        }) as Disposable
    );

    // ── Go to definition ──────────────────────────────────────────────────────
    toDispose.push(
        monaco.languages.registerDefinitionProvider(selector, {
            async provideDefinition(model, position) {
                if (!session.isReady) return undefined;
                syncOpen(model);
                const result = await session.sendRequest<Array<{
                    uri: string;
                    range: {
                        start: { line: number; character: number };
                        end: { line: number; character: number };
                    };
                }> | {
                    uri: string;
                    range: {
                        start: { line: number; character: number };
                        end: { line: number; character: number };
                    };
                } | null>('textDocument/definition', {
                    textDocument: { uri: modelToLspUri(model) },
                    position: toLspPos(position),
                }).catch(() => null);

                if (!result) return undefined;
                const locations = Array.isArray(result) ? result : [result];
                return locations.map(loc => ({
                    uri: monaco.Uri.parse(loc.uri),
                    range: toMonacoRange(loc.range),
                }));
            },
        }) as Disposable
    );
}

// ── LspClientManager ─────────────────────────────────────────────────────────

@injectable()
export class LspClientManager implements FrontendApplicationContribution {

    @inject(new LazyServiceIdentifier(() => ModeService))
    protected readonly modeService!: ModeService;

    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    private readonly _sessions = new Map<string, LspSession>();
    private readonly _starting = new Set<string>();
    private readonly _toDispose = new DisposableCollection();
    private _stopped = false;
    private _workspaceRoot: string | null = null;

    onStart(): void {
        // Fetch the workspace root from the backend once so LSP initialisation
        // sends a real file:// URI to language servers.
        this._fetchWorkspaceRoot().then(() => {
            // If already in monaco mode when we start, kick off connections now.
            if (this.modeService.currentMode === 'monaco') {
                this._startForOpenEditors();
            }
        });

        this._toDispose.push(
            this.modeService.onModeChange(mode => {
                if (mode === 'neovim') {
                    // Don't tear down LSP sessions when switching to neovim.
                    // The language server processes keep running on the backend,
                    // and the sessions will be reused when switching back to monaco.
                    // Disposing here causes the next monaco-mode connection to send
                    // a duplicate initialize request which language servers reject
                    // with -32600 "initialize called while server in initialized state".
                    return;
                } else {
                    this._startForOpenEditors();
                }
            })
        );

        this._toDispose.push(
            this.editorManager.onCreated(widget => {
                if (this.modeService.currentMode !== 'monaco') return;
                this._onEditorCreated(widget);
            })
        );
    }

    onStop(): void {
        this._stopped = true;
        this._disposeAll();
        this._toDispose.dispose();
    }

    private async _fetchWorkspaceRoot(): Promise<void> {
        try {
            const res = await fetch('/api/workspace');
            if (res.ok) {
                const body = await res.json() as { workspace?: string };
                if (body.workspace) {
                    this._workspaceRoot = body.workspace;
                    console.log(`[LspClientManager] workspace root: ${this._workspaceRoot}`);
                }
            }
        } catch (e) {
            console.warn('[LspClientManager] Could not fetch workspace root:', e);
        }
    }

    private _workspaceUri(): string {
        if (this._workspaceRoot) {
            // Encode path into a proper file:// URI
            return 'file://' + this._workspaceRoot;
        }
        // Fallback — language servers will be limited but at least won't crash
        return 'file:///tmp/workspace';
    }

    private _startForOpenEditors(): void {
        for (const widget of this.editorManager.all) {
            this._onEditorCreated(widget);
        }
    }

    private _onEditorCreated(widget: EditorWidget): void {
        const lang = widget.editor.document.languageId;
        const endpoint = LANG_ENDPOINT[lang];
        if (!endpoint) return;
        if (this._sessions.has(endpoint) || this._starting.has(endpoint)) return;
        this._connect(lang, endpoint).catch(() => { /* silent */ });
    }

    private async _connect(lang: string, endpoint: string): Promise<void> {
        if (this._stopped || this._sessions.has(endpoint) || this._starting.has(endpoint)) return;

        this._starting.add(endpoint);
        try {
            const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const url = `${proto}://${window.location.host}/lsp/${endpoint}`;

            console.log(`[LspClientManager] connecting to ${url}`);
            const ws = new WebSocket(url);

            const opened = await new Promise<boolean>(resolve => {
                ws.addEventListener('open', () => resolve(true), { once: true });
                ws.addEventListener('error', (e) => {
                    console.warn(`[LspClientManager] WebSocket error for ${endpoint}:`, e);
                    resolve(false);
                }, { once: true });
            });

            if (!opened || this._stopped) {
                ws.close();
                return;
            }

            const session = new LspSession(ws);
            this._sessions.set(endpoint, session);

            const rootUri = this._workspaceUri();
            console.log(`[LspClientManager] initializing ${endpoint} with rootUri=${rootUri}`);

            await session.initialize(rootUri, [{ uri: rootUri, name: 'workspace' }]);
            console.log(`[LspClientManager] ${endpoint} initialized`);

            if (this._stopped || !this._sessions.has(endpoint)) {
                session.dispose();
                return;
            }

            const providerDisposables = new DisposableCollection();
            const openDocs = new Map<string, number>();
            registerProviders(session, lang, openDocs, providerDisposables);

            // Clean up when session closes
            session.onDispose.then(() => {
                this._sessions.delete(endpoint);
                providerDisposables.dispose();
            });

            this._toDispose.push(providerDisposables);
            this._toDispose.push(session);

        } catch (err) {
            console.warn(`[LspClientManager] "${endpoint}" connect failed:`, err);
            this._sessions.delete(endpoint);
        } finally {
            this._starting.delete(endpoint);
        }
    }

    private _disposeAll(): void {
        for (const session of this._sessions.values()) {
            session.dispose();
        }
        this._sessions.clear();
    }
}
