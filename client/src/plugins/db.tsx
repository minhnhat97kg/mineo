import { useState, useEffect, useCallback, useRef } from 'react';
import { registerPlugin } from './registry';
import type { PluginPaneProps } from './registry';
import '../style/plugin-db.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type View = 'list' | 'form' | 'workspace';

interface Conn {
    id: string;
    label: string;
    driver: string;
    method: string;
    host: string;
    port: number;
    database: string;
    user: string;
    sslMode: string;
    filePath: string;
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyPath: string;
}

interface SchemaColumn { name: string; dataType: string; }
interface SchemaTable  { name: string; type: 'table'|'view'|'collection'; columns?: SchemaColumn[]; }
interface SchemaDB     { name: string; tables: SchemaTable[]; }

interface QueryResult {
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    durationMs: number;
    error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_PORTS: Record<string,number> = { postgres:5432, mysql:3306, sqlite:0, mongo:27017 };

function blankConn(): Conn {
    return { id:'', label:'', driver:'postgres', method:'direct', host:'localhost',
             port:5432, database:'', user:'', sslMode:'disable',
             filePath:'', sshHost:'', sshPort:22, sshUser:'', sshKeyPath:'' };
}

function connSub(c: Conn): string {
    if (c.driver === 'sqlite') return c.filePath || '(no path)';
    const h = c.host || 'localhost';
    const p = c.port || DEFAULT_PORTS[c.driver] || '';
    return c.database ? `${h}:${p}/${c.database}` : `${h}:${p}`;
}

// ── Driver badge ──────────────────────────────────────────────────────────────

function DriverBadge({ driver }: { driver: string }) {
    const lbl: Record<string,string> = { postgres:'PG', mysql:'MySQL', sqlite:'SQLite', mongo:'Mongo' };
    return <span className={`db-driver-badge db-driver-${driver}`}>{lbl[driver] ?? driver}</span>;
}

// ── Connection list ───────────────────────────────────────────────────────────

interface ListProps {
    conns: Conn[];
    status: Record<string,boolean>;
    loading: boolean;
    error: string|null;
    onDismissError: () => void;
    onNew: () => void;
    onEdit: (c: Conn) => void;
    onDelete: (id: string) => void;
    onConnect: (id: string) => void;
    onDisconnect: (id: string) => void;
    onOpen: (c: Conn) => void;
}

function ConnectionListView({ conns, status, loading, error, onDismissError,
    onNew, onEdit, onDelete, onConnect, onDisconnect, onOpen }: ListProps) {
    return (
        <div className="db-root">
            <div className="db-toolbar">
                <span className="db-list-title">Database</span>
                <button className="db-btn db-btn-primary" onClick={onNew}>+ New</button>
            </div>

            {error && (
                <div className="db-error-banner">
                    <span className="db-error-banner-msg">{error}</span>
                    <button className="db-error-banner-close" onClick={onDismissError}>✕</button>
                </div>
            )}

            <div className="db-list-body">
                {loading && <div className="db-conn-empty">Loading…</div>}
                {!loading && conns.length === 0 && (
                    <div className="db-empty-state">
                        <span className="db-empty-state-title">No connections</span>
                        <span>Create one to get started</span>
                    </div>
                )}
                {conns.map(c => (
                    <div key={c.id} className="db-conn-card">
                        <div className={`db-status-dot${status[c.id] ? ' db-connected' : ''}`}
                             title={status[c.id] ? 'Connected' : 'Disconnected'} />
                        <div className="db-conn-info">
                            <div className="db-conn-label">{c.label || '(unnamed)'}</div>
                            <div className="db-conn-sub">
                                <DriverBadge driver={c.driver} />
                                {connSub(c)}
                            </div>
                        </div>
                        <div className="db-conn-actions">
                            {status[c.id] ? (
                                <>
                                    <button className="db-btn db-btn-primary" onClick={() => onOpen(c)}>Open</button>
                                    <button className="db-btn db-btn-icon" onClick={() => onDisconnect(c.id)} title="Disconnect">✕</button>
                                </>
                            ) : (
                                <button className="db-btn db-btn-outline" onClick={() => onConnect(c.id)}>Connect</button>
                            )}
                            <button className="db-btn db-btn-icon" onClick={() => onEdit(c)} title="Edit">✎</button>
                            <button className="db-btn db-btn-icon db-btn-destructive" onClick={() => onDelete(c.id)} title="Delete">⌫</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Connection form ───────────────────────────────────────────────────────────

interface FormProps {
    initial: Conn|null;
    onSave: (c: Conn, pw: string, sshPw: string) => void;
    onCancel: () => void;
}

function ConnectionFormView({ initial, onSave, onCancel }: FormProps) {
    const [f, setF] = useState<Conn>(initial ? { ...initial } : blankConn());
    const [pw, setPw] = useState('');
    const [sshPw, setSshPw] = useState('');
    const [testMsg, setTestMsg] = useState<{ok:boolean; text:string}|null>(null);
    const [testing, setTesting] = useState(false);

    const set = (p: Partial<Conn>) => setF(x => ({ ...x, ...p }));

    const onDriverChange = (driver: string) => set({ driver, port: DEFAULT_PORTS[driver] ?? 5432 });

    const handleTest = async () => {
        setTesting(true); setTestMsg(null);
        try {
            const res = await fetch('/api/plugin/db/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection: f, password: pw, sshPassword: sshPw }),
            });
            const d = await res.json() as { ok: boolean; error?: string };
            setTestMsg({ ok: d.ok, text: d.ok ? 'Connection successful' : (d.error ?? 'Failed') });
        } catch (e) {
            setTestMsg({ ok: false, text: String(e) });
        } finally { setTesting(false); }
    };

    const isSQLite = f.driver === 'sqlite';
    const isMongo  = f.driver === 'mongo';
    const isSSH    = f.method === 'ssh';
    const isSSHKey = f.method === 'ssh-key';

    return (
        <div className="db-root">
            <div className="db-toolbar">
                <button className="db-btn" onClick={onCancel}>← Back</button>
                <span className="db-workspace-name">{initial?.id ? 'Edit Connection' : 'New Connection'}</span>
            </div>

            <div className="db-form-body">

                {/* Identity */}
                <div className="db-section">
                    <div className="db-section-title">Connection</div>
                    <div className="db-field">
                        <label className="db-label">Label</label>
                        <input className="db-input" value={f.label} onChange={e => set({ label: e.target.value })} placeholder="My Database" />
                    </div>
                    <div className="db-row">
                        <div className="db-field">
                            <label className="db-label">Driver</label>
                            <select className="db-select" value={f.driver} onChange={e => onDriverChange(e.target.value)}>
                                <option value="postgres">PostgreSQL</option>
                                <option value="mysql">MySQL / MariaDB</option>
                                <option value="sqlite">SQLite</option>
                                <option value="mongo">MongoDB</option>
                            </select>
                        </div>
                        {!isSQLite && (
                            <div className="db-field">
                                <label className="db-label">Method</label>
                                <select className="db-select" value={f.method} onChange={e => set({ method: e.target.value })}>
                                    <option value="direct">Direct TCP</option>
                                    <option value="ssh">SSH (password)</option>
                                    <option value="ssh-key">SSH (key file)</option>
                                </select>
                            </div>
                        )}
                    </div>
                </div>

                {/* SQLite */}
                {isSQLite && (
                    <div className="db-section">
                        <div className="db-section-title">File</div>
                        <div className="db-field">
                            <label className="db-label">Path</label>
                            <input className="db-input" value={f.filePath} onChange={e => set({ filePath: e.target.value })} placeholder="/path/to/db.sqlite" />
                        </div>
                    </div>
                )}

                {/* TCP */}
                {!isSQLite && (
                    <div className="db-section">
                        <div className="db-section-title">Server</div>
                        <div className="db-row">
                            <div className="db-field">
                                <label className="db-label">Host</label>
                                <input className="db-input" value={f.host} onChange={e => set({ host: e.target.value })} placeholder="localhost" />
                            </div>
                            <div className="db-field db-field-sm">
                                <label className="db-label">Port</label>
                                <input className="db-input" type="number" value={f.port || ''} onChange={e => set({ port: parseInt(e.target.value)||0 })} />
                            </div>
                        </div>
                        <div className="db-row">
                            <div className="db-field">
                                <label className="db-label">Database</label>
                                <input className="db-input" value={f.database} onChange={e => set({ database: e.target.value })} placeholder="mydb" />
                            </div>
                            <div className="db-field">
                                <label className="db-label">Username</label>
                                <input className="db-input" value={f.user} onChange={e => set({ user: e.target.value })} placeholder="postgres" />
                            </div>
                        </div>
                        <div className="db-field">
                            <label className="db-label">Password</label>
                            <input className="db-input" type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="stored encrypted" />
                        </div>
                        {!isMongo && (
                            <div className="db-field">
                                <label className="db-label">SSL</label>
                                <select className="db-select" value={f.sslMode} onChange={e => set({ sslMode: e.target.value })}>
                                    <option value="disable">Disable</option>
                                    <option value="require">Require</option>
                                    <option value="verify-full">Verify Full</option>
                                </select>
                            </div>
                        )}
                    </div>
                )}

                {/* SSH */}
                {(isSSH || isSSHKey) && (
                    <div className="db-section">
                        <div className="db-section-title">SSH Tunnel</div>
                        <div className="db-row">
                            <div className="db-field">
                                <label className="db-label">SSH Host</label>
                                <input className="db-input" value={f.sshHost} onChange={e => set({ sshHost: e.target.value })} placeholder="bastion.example.com" />
                            </div>
                            <div className="db-field db-field-sm">
                                <label className="db-label">Port</label>
                                <input className="db-input" type="number" value={f.sshPort||22} onChange={e => set({ sshPort: parseInt(e.target.value)||22 })} />
                            </div>
                        </div>
                        <div className="db-field">
                            <label className="db-label">SSH Username</label>
                            <input className="db-input" value={f.sshUser} onChange={e => set({ sshUser: e.target.value })} placeholder="ubuntu" />
                        </div>
                        {isSSH && (
                            <div className="db-field">
                                <label className="db-label">SSH Password</label>
                                <input className="db-input" type="password" value={sshPw} onChange={e => setSshPw(e.target.value)} placeholder="stored encrypted" />
                            </div>
                        )}
                        {isSSHKey && (
                            <div className="db-field">
                                <label className="db-label">Key Path (server)</label>
                                <input className="db-input" value={f.sshKeyPath} onChange={e => set({ sshKeyPath: e.target.value })} placeholder="/home/user/.ssh/id_rsa" />
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="db-form-footer">
                <span className={`db-test-msg ${testMsg ? (testMsg.ok ? 'db-test-ok' : 'db-test-err') : ''}`}>
                    {testMsg && (testMsg.ok ? '✓ ' : '✗ ')}{testMsg?.text}
                </span>
                <button className="db-btn db-btn-outline" onClick={handleTest} disabled={testing}>
                    {testing ? 'Testing…' : 'Test'}
                </button>
                <button className="db-btn db-btn-primary" onClick={() => onSave(f, pw, sshPw)}>
                    {initial?.id ? 'Save' : 'Create'}
                </button>
            </div>
        </div>
    );
}

// ── Schema tree ───────────────────────────────────────────────────────────────

interface TreeProps {
    schema: SchemaDB[];
    loading: boolean;
    selected: string;
    onSelect: (db: string, t: SchemaTable) => void;
    onRefresh: () => void;
}

function SchemaTree({ schema, loading, selected, onSelect, onRefresh }: TreeProps) {
    const [openDBs, setOpenDBs]     = useState<Set<string>>(new Set());
    const [openTbls, setOpenTbls]   = useState<Set<string>>(new Set());

    useEffect(() => { if (schema.length > 0) setOpenDBs(new Set([schema[0].name])); }, [schema]);

    const toggleSet = (set: Set<string>, key: string) => {
        const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); return n;
    };

    const tableIcon = (t: SchemaTable) =>
        t.type === 'view' ? '◫' : t.type === 'collection' ? '◉' : '▦';

    return (
        <div className="db-schema-panel">
            <div className="db-schema-header">
                <span className="db-schema-label">Schema</span>
                <button className="db-btn db-btn-icon" onClick={onRefresh} title="Refresh">↺</button>
            </div>
            <div className="db-schema-body">
                {loading && <div className="db-tree-loading">Loading…</div>}
                {schema.map(db => (
                    <div key={db.name}>
                        <div className="db-tree-row db-level-0" onClick={() => setOpenDBs(s => toggleSet(s, db.name))}>
                            <span className={`db-tree-caret${openDBs.has(db.name) ? ' db-open' : ''}`}>▶</span>
                            <span className="db-tree-icon">⊞</span>
                            <span className="db-tree-name">{db.name}</span>
                        </div>
                        {openDBs.has(db.name) && db.tables.map(t => {
                            const key = `${db.name}.${t.name}`;
                            const hasCols = (t.columns ?? []).length > 0;
                            const typeClass = t.type === 'view' ? ' db-tree-view' : t.type === 'collection' ? ' db-tree-coll' : '';
                            return (
                                <div key={key}>
                                    <div
                                        className={`db-tree-row db-level-1${typeClass}${selected === key ? ' db-tree-selected' : ''}`}
                                        onClick={() => { if (hasCols) setOpenTbls(s => toggleSet(s, key)); onSelect(db.name, t); }}
                                    >
                                        <span className={`db-tree-caret${hasCols && openTbls.has(key) ? ' db-open' : ''}`}
                                              style={{ opacity: hasCols ? 1 : 0 }}>▶</span>
                                        <span className="db-tree-icon">{tableIcon(t)}</span>
                                        <span className="db-tree-name">{t.name}</span>
                                    </div>
                                    {openTbls.has(key) && (t.columns ?? []).map(col => (
                                        <div key={col.name} className="db-tree-row db-level-2">
                                            <span className="db-tree-caret" style={{ opacity: 0 }}>▶</span>
                                            <span className="db-tree-icon" style={{ fontSize: 9 }}>◌</span>
                                            <span className="db-tree-name">{col.name}</span>
                                            <span className="db-tree-type-hint">{col.dataType}</span>
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── SQL editor ────────────────────────────────────────────────────────────────

interface EditorProps {
    isMongo: boolean;
    sql: string; onSqlChange: (s: string) => void;
    limit: number; onLimitChange: (n: number) => void;
    onRun: () => void; running: boolean;
}

function SqlEditor({ isMongo, sql, onSqlChange, limit, onLimitChange, onRun, running }: EditorProps) {
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); onRun(); return; }
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.currentTarget;
            const s = ta.selectionStart;
            const v = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
            onSqlChange(v);
            requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
        }
    };
    return (
        <div className="db-editor-wrap">
            <div className="db-editor-header">
                <span className="db-editor-label">{isMongo ? 'Filter (JSON)' : 'SQL'}</span>
                <span className="db-editor-spacer" />
                <span className="db-editor-hint">Ctrl+Enter</span>
                <select className="db-limit-select" value={limit} onChange={e => onLimitChange(parseInt(e.target.value))}>
                    <option value={100}>100</option>
                    <option value={500}>500</option>
                    <option value={1000}>1k</option>
                    <option value={5000}>5k</option>
                </select>
                <button className="db-btn db-btn-primary" onClick={onRun} disabled={running}>
                    {running ? '…' : '▶ Run'}
                </button>
            </div>
            <textarea
                className="db-textarea"
                value={sql}
                onChange={e => onSqlChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isMongo ? '{ "field": "value" }' : 'SELECT * FROM table LIMIT 100'}
                spellCheck={false}
            />
        </div>
    );
}

// ── Results grid ──────────────────────────────────────────────────────────────

const ROW_H  = 22;
const SCAN   = 20;

function ResultsGrid({ result, loading }: { result: QueryResult|null; loading: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const [top, setTop]  = useState(0);
    const [h, setH]      = useState(200);

    useEffect(() => {
        const el = ref.current; if (!el) return;
        const ro = new ResizeObserver(() => setH(el.clientHeight));
        ro.observe(el); return () => ro.disconnect();
    }, []);

    useEffect(() => { if (ref.current) { ref.current.scrollTop = 0; setTop(0); } }, [result]);

    const onScroll = useCallback(() => { if (ref.current) setTop(ref.current.scrollTop); }, []);

    if (loading) return (
        <div className="db-results-panel">
            <div className="db-empty-state"><span>Running query…</span></div>
            <div className="db-status-bar"><span>Running…</span></div>
        </div>
    );

    if (!result) return (
        <div className="db-results-panel">
            <div className="db-empty-state">
                <span className="db-empty-state-title">No results yet</span>
                <span>Run a query or click a table</span>
            </div>
            <div className="db-status-bar"><span>Ready</span></div>
        </div>
    );

    if (result.error) return (
        <div className="db-results-panel">
            <div className="db-error-state">
                <span className="db-error-state-label">Query error</span>
                <span>{result.error}</span>
            </div>
            <div className="db-status-bar"><span className="db-status-err">Error</span></div>
        </div>
    );

    if (result.rows.length === 0) return (
        <div className="db-results-panel">
            <div className="db-empty-state"><span>0 rows returned</span></div>
            <div className="db-status-bar">
                <span className="db-status-ok">0 rows</span>
                <span className="db-status-dot-sep">·</span>
                <span>{result.durationMs}ms</span>
            </div>
        </div>
    );

    const rows   = result.rows;
    const vStart = Math.max(0, Math.floor(top / ROW_H) - SCAN);
    const vEnd   = Math.min(rows.length, vStart + Math.ceil(h / ROW_H) + SCAN * 2);
    const padT   = vStart * ROW_H;
    const padB   = Math.max(0, (rows.length - vEnd) * ROW_H);

    return (
        <div className="db-results-panel">
            <div className="db-grid-scroll" ref={ref} onScroll={onScroll}>
                <table className="db-grid">
                    <thead className="db-grid-head">
                        <tr>{result.columns.map(c => <th key={c} className="db-grid-th">{c}</th>)}</tr>
                    </thead>
                    <tbody>
                        {padT > 0 && <tr style={{ height: padT }}><td colSpan={result.columns.length} style={{ padding:0, border:'none' }} /></tr>}
                        {rows.slice(vStart, vEnd).map((row, i) => {
                            const abs = vStart + i;
                            return (
                                <tr key={abs} className={`db-grid-tr${abs % 2 ? ' db-row-alt' : ''}`} style={{ height: ROW_H }}>
                                    {(row as unknown[]).map((cell, ci) => (
                                        <td key={ci} className={`db-grid-td${cell === null ? ' db-null' : ''}`}>
                                            {cell === null ? 'NULL' : String(cell)}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                        {padB > 0 && <tr style={{ height: padB }}><td colSpan={result.columns.length} style={{ padding:0, border:'none' }} /></tr>}
                    </tbody>
                </table>
            </div>
            <div className="db-status-bar">
                <span className="db-status-ok">{result.rowCount.toLocaleString()} rows</span>
                <span className="db-status-dot-sep">·</span>
                <span>{result.durationMs}ms</span>
                {rows.length >= 10000 && <><span className="db-status-dot-sep">·</span><span className="db-status-warn">capped at 10k</span></>}
            </div>
        </div>
    );
}

// ── Workspace view ────────────────────────────────────────────────────────────

function WorkspaceView({ conn, onBack, onDisconnect }: { conn: Conn; onBack: ()=>void; onDisconnect: ()=>void }) {
    const [schema, setSchema]         = useState<SchemaDB[]>([]);
    const [schemaLoad, setSchemaLoad] = useState(true);
    const [selected, setSelected]     = useState('');
    const [mongoColl, setMongoColl]   = useState('');
    const [sql, setSql]               = useState('');
    const [limit, setLimit]           = useState(100);
    const [result, setResult]         = useState<QueryResult|null>(null);
    const [running, setRunning]       = useState(false);
    const isMongo = conn.driver === 'mongo';

    const loadSchema = useCallback(() => {
        setSchemaLoad(true);
        fetch(`/api/plugin/db/schema?conn=${encodeURIComponent(conn.id)}`)
            .then(r => r.json())
            .then((d: { schema: SchemaDB[] }) => setSchema(d.schema ?? []))
            .catch(() => setSchema([]))
            .finally(() => setSchemaLoad(false));
    }, [conn.id]);

    useEffect(() => { loadSchema(); }, [loadSchema]);

    const runQuery = useCallback((q: string, coll: string, lim: number) => {
        setRunning(true); setResult(null);
        fetch('/api/plugin/db/query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conn: conn.id, sql: q, limit: lim, collection: coll }),
        })
            .then(r => r.json()).then((d: QueryResult) => setResult(d))
            .catch(e => setResult({ columns:[], rows:[], rowCount:0, durationMs:0, error: String(e) }))
            .finally(() => setRunning(false));
    }, [conn.id]);

    const handleSelect = useCallback((dbName: string, t: SchemaTable) => {
        const key = `${dbName}.${t.name}`;
        setSelected(key);
        if (isMongo) {
            setMongoColl(t.name); setSql('{}');
            runQuery('{}', t.name, limit);
        } else {
            const q = `SELECT * FROM ${t.name} LIMIT ${limit}`;
            setSql(q); runQuery(q, '', limit);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMongo, limit, runQuery]);

    return (
        <div className="db-root">
            <div className="db-toolbar">
                <button className="db-btn" onClick={onBack}>←</button>
                <span className="db-workspace-name">{conn.label || '(unnamed)'}</span>
                <DriverBadge driver={conn.driver} />
                <button className="db-btn db-btn-destructive" onClick={onDisconnect}>Disconnect</button>
            </div>
            <div className="db-workspace-body">
                <SchemaTree schema={schema} loading={schemaLoad} selected={selected}
                    onSelect={handleSelect} onRefresh={loadSchema} />
                <div className="db-right-panel">
                    <SqlEditor isMongo={isMongo} sql={sql} onSqlChange={setSql}
                        limit={limit} onLimitChange={setLimit}
                        onRun={() => runQuery(sql, mongoColl, limit)} running={running} />
                    <ResultsGrid result={result} loading={running} />
                </div>
            </div>
        </div>
    );
}

// ── Root pane ─────────────────────────────────────────────────────────────────

function DatabasePane(_props: PluginPaneProps) {
    const [view, setView]         = useState<View>('list');
    const [conns, setConns]       = useState<Conn[]>([]);
    const [status, setStatus]     = useState<Record<string,boolean>>({});
    const [loading, setLoading]   = useState(true);
    const [editConn, setEditConn] = useState<Conn|null>(null);
    const [active, setActive]     = useState<Conn|null>(null);
    const [error, setError]       = useState<string|null>(null);

    const loadConns = useCallback(() => {
        setLoading(true);
        fetch('/api/plugin/db/connections')
            .then(r => r.json()).then((d: { connections: Conn[] }) => setConns(d.connections ?? []))
            .catch(() => setConns([])).finally(() => setLoading(false));
    }, []);

    const loadStatus = useCallback(() => {
        fetch('/api/plugin/db/status')
            .then(r => r.json()).then((s: Record<string,boolean>) => setStatus(s))
            .catch(() => {});
    }, []);

    useEffect(() => { loadConns(); loadStatus(); }, [loadConns, loadStatus]);
    useEffect(() => { const id = setInterval(loadStatus, 10_000); return () => clearInterval(id); }, [loadStatus]);

    const handleSave = async (c: Conn, pw: string, sshPw: string) => {
        const url  = c.id ? `/api/plugin/db/connections/${c.id}` : '/api/plugin/db/connections';
        const meth = c.id ? 'PUT' : 'POST';
        await fetch(url, { method: meth, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection: c, password: pw, sshPassword: sshPw }) });
        loadConns(); setView('list');
    };

    const handleDelete = async (id: string) => {
        await fetch(`/api/plugin/db/connections/${id}`, { method: 'DELETE' });
        loadConns(); loadStatus();
    };

    const handleConnect = async (id: string) => {
        setError(null);
        const res  = await fetch('/api/plugin/db/connect', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (data.error) { setError(data.error); return; }
        await loadStatus();
        const c = conns.find(x => x.id === id);
        if (c) { setActive(c); setView('workspace'); }
    };

    const handleDisconnect = async (id: string) => {
        await fetch('/api/plugin/db/disconnect', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        if (active?.id === id) setActive(null);
        loadStatus();
    };

    if (view === 'workspace' && active) return (
        <WorkspaceView conn={active} onBack={() => setView('list')}
            onDisconnect={() => { handleDisconnect(active.id); setView('list'); setActive(null); }} />
    );

    if (view === 'form') return (
        <ConnectionFormView initial={editConn} onSave={handleSave} onCancel={() => setView('list')} />
    );

    return (
        <ConnectionListView conns={conns} status={status} loading={loading}
            error={error} onDismissError={() => setError(null)}
            onNew={() => { setEditConn(null); setView('form'); }}
            onEdit={c => { setEditConn(c); setView('form'); }}
            onDelete={handleDelete}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onOpen={c => { setActive(c); setView('workspace'); }} />
    );
}

// ── Register ──────────────────────────────────────────────────────────────────

registerPlugin({
    id: 'db',
    title: 'Database',
    iconClass: 'devicon-postgresql-plain colored',
    component: DatabasePane,
});
