import { injectable, inject, LazyServiceIdentifier } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import { Parser, Language } from 'web-tree-sitter';
import type { Node as TsNode } from 'web-tree-sitter';
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

// Token scope names must match what Monaco's theme trie actually has.
// dark_vs/dark_plus define direct rules for: comment, string, keyword,
// constant.numeric, entity.name.type, entity.name.function, variable.
// Scopes that have no theme rule (e.g. plain 'identifier') render as the
// default foreground colour — still readable but not distinctly coloured.
const JS_TS_TOKEN_MAP: Record<string, string> = {
    comment:             'comment',
    string:              'string',
    template_string:     'string',
    number:              'constant.numeric',
    keyword:             'keyword',
    type_identifier:     'entity.name.type',
    property_identifier: 'variable',
    function_identifier: 'entity.name.function',
};

const LANGUAGES: Record<string, LangConfig> = {
    typescript: {
        wasmPath: '/grammars/tree-sitter-typescript.wasm',
        tokenMap: JS_TS_TOKEN_MAP,
    },
    typescriptreact: {
        wasmPath: '/grammars/tree-sitter-typescript.wasm',
        tokenMap: JS_TS_TOKEN_MAP,
    },
    javascript: {
        wasmPath: '/grammars/tree-sitter-typescript.wasm',
        tokenMap: JS_TS_TOKEN_MAP,
    },
    javascriptreact: {
        wasmPath: '/grammars/tree-sitter-typescript.wasm',
        tokenMap: JS_TS_TOKEN_MAP,
    },
    python: {
        wasmPath: '/grammars/tree-sitter-python.wasm',
        tokenMap: {
            comment:    'comment',
            string:     'string',
            integer:    'constant.numeric',
            float:      'constant.numeric',
            keyword:    'keyword',
            type:       'entity.name.type',
            identifier: 'variable',
        },
    },
    go: {
        wasmPath: '/grammars/tree-sitter-go.wasm',
        tokenMap: {
            comment:                    'comment',
            interpreted_string_literal: 'string',
            raw_string_literal:         'string',
            int_literal:                'constant.numeric',
            float_literal:              'constant.numeric',
            keyword:                    'keyword',
            type_identifier:            'entity.name.type',
            field_identifier:           'variable',
        },
    },
    rust: {
        wasmPath: '/grammars/tree-sitter-rust.wasm',
        tokenMap: {
            line_comment:    'comment',
            block_comment:   'comment',
            string_literal:  'string',
            integer_literal: 'constant.numeric',
            float_literal:   'constant.numeric',
            keyword:         'keyword',
            type_identifier: 'entity.name.type',
            field_identifier:'variable',
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

                    function walk(node: TsNode): void {
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
