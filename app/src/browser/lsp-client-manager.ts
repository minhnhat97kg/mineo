import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { MessageTransports } from 'vscode-languageclient/lib/common/client';
import {
    ReadableStreamMessageReader,
    WriteableStreamMessageWriter,
} from 'vscode-jsonrpc/lib/common/api';
import { ModeService } from './mineo-frontend-module';

// ── Language → LSP endpoint mapping ──────────────────────────────────────────

const LANG_ENDPOINT: Record<string, string> = {
    typescript:      'typescript',
    typescriptreact: 'typescript',
    javascript:      'typescript',
    python:          'python',
    go:              'go',
    rust:            'rust',
};

// ── Minimal RAL-compatible stream wrappers around a browser WebSocket ─────────

/** Wraps a WebSocket as a RAL.ReadableStream for ReadableStreamMessageReader. */
class WsReadableStream {
    private readonly _onDataListeners: Array<(data: Uint8Array) => void> = [];
    private readonly _onCloseListeners: Array<() => void> = [];
    private readonly _onErrorListeners: Array<(err: unknown) => void> = [];
    private readonly _onEndListeners: Array<() => void> = [];

    constructor(private readonly ws: WebSocket) {
        ws.binaryType = 'arraybuffer';

        ws.addEventListener('message', (ev: MessageEvent) => {
            let data: Uint8Array;
            if (ev.data instanceof ArrayBuffer) {
                data = new Uint8Array(ev.data);
            } else if (typeof ev.data === 'string') {
                data = new TextEncoder().encode(ev.data);
            } else {
                return;
            }
            for (const l of this._onDataListeners) l(data);
        });

        ws.addEventListener('close', () => {
            for (const l of this._onCloseListeners) l();
            for (const l of this._onEndListeners) l();
        });

        ws.addEventListener('error', (ev) => {
            for (const l of this._onErrorListeners) l(ev);
        });
    }

    onData(listener: (data: Uint8Array) => void): Disposable {
        this._onDataListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onDataListeners.indexOf(listener);
            if (i >= 0) this._onDataListeners.splice(i, 1);
        });
    }

    onClose(listener: () => void): Disposable {
        this._onCloseListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onCloseListeners.indexOf(listener);
            if (i >= 0) this._onCloseListeners.splice(i, 1);
        });
    }

    onError(listener: (error: unknown) => void): Disposable {
        this._onErrorListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onErrorListeners.indexOf(listener);
            if (i >= 0) this._onErrorListeners.splice(i, 1);
        });
    }

    onEnd(listener: () => void): Disposable {
        this._onEndListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onEndListeners.indexOf(listener);
            if (i >= 0) this._onEndListeners.splice(i, 1);
        });
    }
}

/** Wraps a WebSocket as a RAL.WritableStream for WriteableStreamMessageWriter. */
class WsWritableStream {
    private readonly _onCloseListeners: Array<() => void> = [];
    private readonly _onErrorListeners: Array<(err: unknown) => void> = [];
    private readonly _onEndListeners: Array<() => void> = [];

    constructor(private readonly ws: WebSocket) {
        ws.addEventListener('close', () => {
            for (const l of this._onCloseListeners) l();
            for (const l of this._onEndListeners) l();
        });
        ws.addEventListener('error', (ev) => {
            for (const l of this._onErrorListeners) l(ev);
        });
    }

    onClose(listener: () => void): Disposable {
        this._onCloseListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onCloseListeners.indexOf(listener);
            if (i >= 0) this._onCloseListeners.splice(i, 1);
        });
    }

    onError(listener: (error: unknown) => void): Disposable {
        this._onErrorListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onErrorListeners.indexOf(listener);
            if (i >= 0) this._onErrorListeners.splice(i, 1);
        });
    }

    onEnd(listener: () => void): Disposable {
        this._onEndListeners.push(listener);
        return Disposable.create(() => {
            const i = this._onEndListeners.indexOf(listener);
            if (i >= 0) this._onEndListeners.splice(i, 1);
        });
    }

    write(data: Uint8Array | string, _encoding?: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    if (typeof data === 'string') {
                        this.ws.send(data);
                    } else {
                        this.ws.send(data.buffer);
                    }
                    resolve();
                } else {
                    reject(new Error('WebSocket is not open'));
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    end(): void {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
        }
    }
}

// ── Build a MessageTransports pair from a WebSocket ───────────────────────────

function createWebSocketTransports(ws: WebSocket): MessageTransports {
    const readable = new WsReadableStream(ws);
    const writable = new WsWritableStream(ws);
    const reader = new ReadableStreamMessageReader(readable as never);
    const writer = new WriteableStreamMessageWriter(writable as never);
    return { reader, writer };
}

// ── LspClientManager ─────────────────────────────────────────────────────────

@injectable()
export class LspClientManager implements FrontendApplicationContribution {

    @inject(ModeService)
    protected readonly modeService!: ModeService;

    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    /** Active LSP clients keyed by language endpoint (e.g. "typescript"). */
    private readonly _clients = new Map<string, MonacoLanguageClient>();

    /** WebSockets kept so we can close them on dispose. */
    private readonly _sockets = new Map<string, WebSocket>();

    private readonly _toDispose = new DisposableCollection();

    onStart(): void {
        // When switching to neovim mode dispose all LSP clients
        this._toDispose.push(
            this.modeService.onModeChange(mode => {
                if (mode === 'neovim') {
                    this.disposeAll();
                }
            })
        );

        // When a new editor widget is opened, start the LSP client if needed
        this._toDispose.push(
            this.editorManager.onCreated(widget => {
                if (this.modeService.currentMode !== 'monaco') return;
                this._onEditorCreated(widget);
            })
        );
    }

    onStop(): void {
        this.disposeAll();
        this._toDispose.dispose();
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private _onEditorCreated(widget: EditorWidget): void {
        const languageId = widget.editor.document.languageId;
        const endpoint = LANG_ENDPOINT[languageId];
        if (!endpoint) return;
        if (this._clients.has(endpoint)) return; // already running
        this.startClient(languageId).catch(() => { /* silently ignore */ });
    }

    async startClient(lang: string): Promise<void> {
        // Resolve the endpoint (e.g. 'typescriptreact' → 'typescript')
        const endpoint = LANG_ENDPOINT[lang] ?? lang;
        if (this._clients.has(endpoint)) return;

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${window.location.host}/lsp/${endpoint}`;

        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            return;
        }

        this._sockets.set(endpoint, ws);

        // Wait for open (or fail silently)
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error(`WebSocket error for ${url}`)), { once: true });
        }).catch(() => {
            this._sockets.delete(endpoint);
        });

        if (ws.readyState !== WebSocket.OPEN) return;

        const transports = createWebSocketTransports(ws);

        const client = new MonacoLanguageClient({
            name: `Mineo LSP (${endpoint})`,
            clientOptions: {
                documentSelector: [{ language: lang, scheme: 'file' }],
            },
            connectionProvider: {
                get: (_encoding: string) => Promise.resolve(transports),
            },
        });

        this._clients.set(endpoint, client);

        try {
            client.start();
        } catch {
            this._clients.delete(endpoint);
            this._sockets.delete(endpoint);
        }
    }

    disposeAll(): void {
        for (const [key, client] of this._clients) {
            try {
                client.stop();
            } catch { /* ignore */ }
            this._clients.delete(key);
        }
        for (const [key, ws] of this._sockets) {
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            } catch { /* ignore */ }
            this._sockets.delete(key);
        }
    }
}
