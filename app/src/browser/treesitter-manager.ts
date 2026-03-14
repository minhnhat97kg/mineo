import { injectable, inject, LazyServiceIdentifier } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import { Parser, Language, Node } from 'web-tree-sitter';
import { Disposable } from '@theia/core/lib/common/disposable';
import { ModeService } from './mode-service';

// ── Minimal Monaco IState implementation ─────────────────────────────────────

const INITIAL_STATE: monaco.languages.IState = {
    clone() { return this; },
    equals(other: monaco.languages.IState) { return this === other; },
};

// ── Language configuration ────────────────────────────────────────────────────

interface LangConfig {
    wasmPath: string;
    tokenMap: Record<string, string>;
}

const LANGUAGES: Record<string, LangConfig> = {
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
    python: {
        wasmPath: '/grammars/tree-sitter-python.wasm',
        tokenMap: {
            comment: 'comment',
            string: 'string',
            integer: 'number',
            float: 'number',
            keyword: 'keyword',
            identifier: 'identifier',
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

// ── TreesitterManager ─────────────────────────────────────────────────────────

@injectable()
export class TreesitterManager implements FrontendApplicationContribution {

    @inject(new LazyServiceIdentifier(() => ModeService)) protected readonly modeService!: ModeService;

    private _initialized = false;
    private readonly _parsers = new Map<string, Parser>();
    private readonly _registrations = new Map<string, Disposable>();

    onStart(): void {
        if (this.modeService.currentMode === 'monaco') {
            this._initialize();
        }

        this.modeService.onModeChange(mode => {
            if (!this._initialized && mode === 'monaco') {
                this._initialize();
            }
        });
    }

    private _initialize(): void {
        if (this._initialized) return;
        this._initialized = true; // guard re-entry immediately before any async work

        Parser.init({ locateFile: () => '/grammars/tree-sitter.wasm' })
            .then(() => {
                const work: Promise<void>[] = [];
                for (const [lang, cfg] of Object.entries(LANGUAGES)) {
                    work.push(this._registerLanguage(lang, cfg.wasmPath, cfg.tokenMap));
                }
                return Promise.all(work);
            })
            .then(() => {
                this._initialized = true;
            })
            .catch(err => {
                console.warn('[TreesitterManager] init failed — falling back to Monaco tokenizer:', err);
                // Mark as initialized so we don't retry on every subsequent mode switch
                this._initialized = true;
            });
    }

    private async _registerLanguage(
        lang: string,
        wasmPath: string,
        tokenMap: Record<string, string>,
    ): Promise<void> {
        try {
            const language = await Language.load(wasmPath);
            const parser = new Parser();
            parser.setLanguage(language);
            this._parsers.set(lang, parser);

            const provider: monaco.languages.TokensProvider = {
                getInitialState(): monaco.languages.IState {
                    return INITIAL_STATE;
                },

                tokenize(line: string, state: monaco.languages.IState): monaco.languages.ILineTokens {
                    const tree = parser.parse(line);
                    if (!tree) {
                        return { tokens: [], endState: state };
                    }
                    const tokens: monaco.languages.IToken[] = [];
                    const seenStarts = new Set<number>();

                    function walk(node: Node): void {
                        if (node.isNamed && node.childCount === 0 && tokenMap[node.type] !== undefined) {
                            const startIndex = node.startIndex;
                            if (!seenStarts.has(startIndex)) {
                                seenStarts.add(startIndex);
                                tokens.push({
                                    startIndex,
                                    scopes: tokenMap[node.type],
                                });
                            }
                        }
                        for (const child of node.children) {
                            if (child) walk(child);
                        }
                    }

                    try {
                        walk(tree.rootNode);
                    } finally {
                        // Must call tree.delete() — web-tree-sitter allocates in WASM
                        // heap which is not GC'd; leaking trees causes OOM on large files.
                        tree.delete();
                    }

                    tokens.sort((a, b) => a.startIndex - b.startIndex);

                    return { tokens, endState: state };
                },
            };

            // Ensure the language is registered before setting the tokens provider.
            // Theia registers languages lazily; setTokensProvider throws if the
            // language ID is unknown at call time.
            const knownIds = monaco.languages.getLanguages().map(l => l.id);
            if (!knownIds.includes(lang)) {
                monaco.languages.register({ id: lang });
            }

            const disposable = monaco.languages.setTokensProvider(lang, provider);
            // Wrap monaco IDisposable in Theia Disposable
            this._registrations.set(lang, { dispose: () => disposable.dispose() });
        } catch (err) {
            console.warn(`[TreesitterManager] failed to register language "${lang}" — falling back:`, err);
        }
    }
}
