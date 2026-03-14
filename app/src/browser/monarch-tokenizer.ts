/**
 * MonarchTokenizer — replaces the broken TreeSitter line tokenizer.
 *
 * Why Monarch instead of TreeSitter:
 * - Monaco calls setTokensProvider() line-by-line. TreeSitter needs full document
 *   context; parsing a single line produces almost entirely ERROR nodes, so the
 *   tokenMap lookups never match and nothing gets coloured.
 * - Monarch is Monaco's native line tokenizer: a state-machine that carries
 *   state across lines (multiline strings/comments work), runs synchronously
 *   (no WASM, no async init, no OOM risk).
 *
 * Token names MUST match Monaco's built-in theme trie keys (themes.js):
 *   'keyword'  → #569CD6   'string'  → #CE9178   'comment' → #608B4E
 *   'number'   → #B5CEA8   'type'    → #3DC9B0    'tag'     → #569CD6
 *   'variable' → #74B0DF   'variable.parameter' → #9CDCFE
 *
 * These are NOT TextMate scope names. TextMate scopes like 'entity.name.type'
 * and 'constant.numeric' have no entry in Monaco's standalone theme trie and
 * produce no colour. Use the short Monarch-native names above.
 */

import { injectable, inject, LazyServiceIdentifier } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import { Disposable } from '@theia/core/lib/common/disposable';
import { ModeService } from './mode-service';

// ── Monarch grammar definitions ───────────────────────────────────────────────

// TypeScript / JavaScript / TSX / JSX share the same grammar.
const TS_JS_MONARCH: monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '',
    keywords: [
        'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class',
        'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
        'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
        'function', 'get', 'if', 'implements', 'import', 'in', 'infer',
        'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace',
        'never', 'new', 'null', 'of', 'override', 'package', 'private',
        'protected', 'public', 'readonly', 'require', 'return', 'set', 'static',
        'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
        'undefined', 'var', 'void', 'while', 'with', 'yield',
    ],
    typeKeywords: ['any', 'boolean', 'number', 'object', 'string', 'symbol', 'bigint', 'unknown'],
    tokenizer: {
        root: [
            // Template literals
            [/`/, 'string', '@template'],
            // Single / double quoted strings
            [/"([^"\\]|\\.)*$/, 'string'],
            [/'([^'\\]|\\.)*$/, 'string'],
            [/"/, 'string', '@string_double'],
            [/'/, 'string', '@string_single'],
            // Block comment
            [/\/\*/, 'comment', '@block_comment'],
            // Line comment
            [/\/\/.*$/, 'comment'],
            // Numbers
            [/0[xX][0-9a-fA-F]+n?/, 'number.hex'],
            [/0[oO][0-7]+n?/, 'number'],
            [/0[bB][01]+n?/, 'number'],
            [/\d+n/, 'number'],
            [/\d*\.\d+([eE][+-]?\d+)?/, 'number'],
            [/\d+([eE][+-]?\d+)?/, 'number'],
            // Decorators
            [/@[a-zA-Z_$][\w$]*/, 'annotation'],
            // Identifiers / keywords
            [/[a-zA-Z_$][\w$]*/, {
                cases: {
                    '@typeKeywords': 'type',
                    '@keywords': 'keyword',
                    '@default': '',
                },
            }],
            // Whitespace
            [/\s+/, ''],
        ],
        string_double: [
            [/[^"\\]+/, 'string'],
            [/\\./, 'string'],
            [/"/, 'string', '@pop'],
        ],
        string_single: [
            [/[^'\\]+/, 'string'],
            [/\\./, 'string'],
            [/'/, 'string', '@pop'],
        ],
        template: [
            [/[^`\\$]+/, 'string'],
            [/\\./, 'string'],
            [/\$\{/, 'delimiter.bracket', '@template_expression'],
            [/`/, 'string', '@pop'],
        ],
        template_expression: [
            [/\}/, 'delimiter.bracket', '@pop'],
            { include: 'root' },
        ],
        block_comment: [
            [/[^*/]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/./, 'comment'],
        ],
    },
};

const PYTHON_MONARCH: monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '',
    keywords: [
        'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
        'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for',
        'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
        'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try',
        'while', 'with', 'yield',
    ],
    builtins: [
        'abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr',
        'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
        'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
        'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
        'len', 'list', 'locals', 'map', 'max', 'min', 'next', 'object', 'oct',
        'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed',
        'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str',
        'sum', 'super', 'tuple', 'type', 'vars', 'zip',
    ],
    tokenizer: {
        root: [
            // Triple-quoted strings
            [/"""/, 'string', '@triple_double'],
            [/'''/, 'string', '@triple_single'],
            // Formatted strings
            [/[fFbBrRuU]"""/, 'string', '@triple_double'],
            [/[fFbBrRuU]'''/, 'string', '@triple_single'],
            // Single-line strings
            [/"([^"\\]|\\.)*"/, 'string'],
            [/'([^'\\]|\\.)*'/, 'string'],
            [/[fFbBrRuU]"([^"\\]|\\.)*"/, 'string'],
            [/[fFbBrRuU]'([^'\\]|\\.)*'/, 'string'],
            // Comments
            [/#.*$/, 'comment'],
            // Numbers
            [/0[xX][0-9a-fA-F]+/, 'number.hex'],
            [/0[oO][0-7]+/, 'number'],
            [/0[bB][01]+/, 'number'],
            [/\d*\.\d+([eE][+-]?\d+)?[jJ]?/, 'number'],
            [/\d+[jJ]/, 'number'],
            [/\d+/, 'number'],
            // Decorator
            [/@[a-zA-Z_]\w*/, 'annotation'],
            // Identifiers
            [/[a-zA-Z_]\w*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@builtins': 'type',
                    '@default': '',
                },
            }],
            [/\s+/, ''],
        ],
        triple_double: [
            [/"""/, 'string', '@pop'],
            [/./, 'string'],
        ],
        triple_single: [
            [/'''/, 'string', '@pop'],
            [/./, 'string'],
        ],
    },
};

const GO_MONARCH: monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '',
    keywords: [
        'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
        'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
        'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
        'var', 'nil', 'true', 'false', 'iota',
    ],
    builtins: [
        'append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
        'make', 'new', 'panic', 'print', 'println', 'real', 'recover',
        'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
        'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
        'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
    ],
    tokenizer: {
        root: [
            // Raw string
            [/`[^`]*`/, 'string'],
            // Interpreted string
            [/"([^"\\]|\\.)*"/, 'string'],
            // Rune literal
            [/'([^'\\]|\\.)+'/, 'string'],
            // Block comment
            [/\/\*/, 'comment', '@block_comment'],
            // Line comment
            [/\/\/.*$/, 'comment'],
            // Numbers
            [/0[xX][0-9a-fA-F_]+/, 'number.hex'],
            [/0[oO][0-7_]+/, 'number'],
            [/0[bB][01_]+/, 'number'],
            [/\d[\d_]*\.[\d_]*([eE][+-]?[\d_]+)?/, 'number'],
            [/\d[\d_]*/, 'number'],
            // Identifiers
            [/[a-zA-Z_]\w*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@builtins': 'type',
                    '@default': '',
                },
            }],
            [/\s+/, ''],
        ],
        block_comment: [
            [/[^*/]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/./, 'comment'],
        ],
    },
};

const RUST_MONARCH: monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '',
    keywords: [
        'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
        'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
        'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
        'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
        'union', 'unsafe', 'use', 'where', 'while',
    ],
    primitives: [
        'bool', 'char', 'f32', 'f64', 'i8', 'i16', 'i32', 'i64', 'i128',
        'isize', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    ],
    tokenizer: {
        root: [
            // Raw string
            [/r#+"[^"]*"#*/, 'string'],
            // Byte string / string
            [/b?"([^"\\]|\\.)*"/, 'string'],
            // Char / byte
            [/b?'([^'\\]|\\.)'/, 'string'],
            // Block comment (nestable handled approximately)
            [/\/\*/, 'comment', '@block_comment'],
            // Line comment
            [/\/\/.*$/, 'comment'],
            // Numbers with suffix
            [/0[xX][0-9a-fA-F_]+(_?[iu]\d+)?/, 'number.hex'],
            [/0[oO][0-7_]+(_?[iu]\d+)?/, 'number'],
            [/0[bB][01_]+(_?[iu]\d+)?/, 'number'],
            [/\d[\d_]*\.[\d_]*([eE][+-]?[\d_]+)?(_?f\d+)?/, 'number'],
            [/\d[\d_]*(_?[iu]\d+)?/, 'number'],
            // Macro invocation (name!)
            [/[a-zA-Z_]\w*!/, 'tag'],
            // Lifetime
            [/'[a-zA-Z_]\w*/, 'type'],
            // Identifiers
            [/[a-zA-Z_]\w*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@primitives': 'type',
                    '@default': '',
                },
            }],
            [/\s+/, ''],
        ],
        block_comment: [
            [/[^*/]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/./, 'comment'],
        ],
    },
};

// ── Language map ──────────────────────────────────────────────────────────────

const MONARCH_GRAMMARS: Record<string, monaco.languages.IMonarchLanguage> = {
    typescript:     TS_JS_MONARCH,
    typescriptreact: TS_JS_MONARCH,
    javascript:     TS_JS_MONARCH,
    javascriptreact: TS_JS_MONARCH,
    python:         PYTHON_MONARCH,
    go:             GO_MONARCH,
    rust:           RUST_MONARCH,
};

// ── MonarchTokenizer contribution ────────────────────────────────────────────

@injectable()
export class MonarchTokenizer implements FrontendApplicationContribution {

    @inject(new LazyServiceIdentifier(() => ModeService)) protected readonly modeService!: ModeService;

    private _registered = false;
    private readonly _registrations = new Map<string, Disposable>();

    onStart(): void {
        if (this.modeService.currentMode === 'monaco') {
            this._register();
        }
        this.modeService.onModeChange(mode => {
            if (mode === 'monaco' && !this._registered) {
                this._register();
            }
        });
    }

    private _register(): void {
        if (this._registered) return;
        this._registered = true;

        for (const [lang, grammar] of Object.entries(MONARCH_GRAMMARS)) {
            try {
                // Ensure language is registered before setting the provider.
                const known = monaco.languages.getLanguages().map(l => l.id);
                if (!known.includes(lang)) {
                    monaco.languages.register({ id: lang });
                }
                const disposable = monaco.languages.setMonarchTokensProvider(lang, grammar);
                this._registrations.set(lang, { dispose: () => disposable.dispose() });
            } catch (err) {
                console.warn(`[MonarchTokenizer] failed to register "${lang}":`, err);
            }
        }
    }
}
