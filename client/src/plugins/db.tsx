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
    createdAt?: string;
    updatedAt?: string;
}

interface SchemaColumn {
    name: string;
    dataType: string;
}

interface SchemaTable {
    name: string;
    type: 'table' | 'view' | 'collection';
    columns?: SchemaColumn[];
}

interface SchemaDatabase {
    name: string;
    tables: SchemaTable[];
}

interface QueryResult {
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    durationMs: number;
    error?: string;
}

// ── Default connection ────────────────────────────────────────────────────────

function emptyConn(): Conn {
    return {
        id: '',
        label: '',
        driver: 'postgres',
        method: 'direct',
        host: 'localhost',
        port: 5432,
        database: '',
        user: '',
        sslMode: 'disable',
        filePath: '',
        sshHost: '',
        sshPort: 22,
        sshUser: '',
        sshKeyPath: '',
    };
}

const DEFAULT_PORTS: Record<string, number> = {
    postgres: 5432,
    mysql: 3306,
    sqlite: 0,
    mongo: 27017,
};

// ── Driver badge ──────────────────────────────────────────────────────────────

function DriverBadge({ driver }: { driver: string }) {
    return (
        <span className={`db-driver-badge db-driver-${driver}`}>
            {driver === 'mongo' ? 'MongoDB' : driver === 'sqlite' ? 'SQLite' : driver === 'mysql' ? 'MySQL' : 'Postgres'}
        </span>
    );
}

// ── Connection card ───────────────────────────────────────────────────────────

interface ConnCardProps {
    conn: Conn;
    connected: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onOpen: () => void;
}

function ConnCard({ conn, connected, onConnect, onDisconnect, onEdit, onDelete, onOpen }: ConnCardProps) {
    const subText = conn.driver === 'sqlite'
        ? (conn.filePath || '(no path)')
        : `${conn.host || 'localhost'}:${conn.port || DEFAULT_PORTS[conn.driver] || ''}${conn.database ? ' / ' + conn.database : ''}`;

    return (
        <div className="db-conn-card">
            <div className={`db-status-dot ${connected ? 'db-connected' : ''}`} title={connected ? 'Connected' : 'Not connected'} />
            <div className="db-conn-card-info">
                <div className="db-conn-card-label">{conn.label || '(unnamed)'}</div>
                <div className="db-conn-card-sub">
                    <DriverBadge driver={conn.driver} />
                    {' '}{subText}
                </div>
            </div>
            <div className="db-conn-card-actions">
                {connected ? (
                    <button className="db-btn db-btn-primary" onClick={onOpen} title="Open workspace">Open</button>
                ) : (
                    <button className="db-btn db-btn-primary" onClick={onConnect} title="Connect">Connect</button>
                )}
                {connected && (
                    <button className="db-btn db-btn-ghost" onClick={onDisconnect} title="Disconnect">✕</button>
                )}
                <button className="db-btn db-btn-ghost" onClick={onEdit} title="Edit">✎</button>
                <button className="db-btn db-btn-ghost db-btn-danger" onClick={onDelete} title="Delete">🗑</button>
            </div>
        </div>
    );
}

// ── Connection list view ──────────────────────────────────────────────────────

interface ConnectionListViewProps {
    conns: Conn[];
    status: Record<string, boolean>;
    loading: boolean;
    onNew: () => void;
    onEdit: (conn: Conn) => void;
    onDelete: (id: string) => void;
    onConnect: (id: string) => void;
    onDisconnect: (id: string) => void;
    onOpen: (conn: Conn) => void;
}

function ConnectionListView({
    conns, status, loading, onNew, onEdit, onDelete, onConnect, onDisconnect, onOpen,
}: ConnectionListViewProps) {
    return (
        <div className="db-root">
            <div className="db-conn-list-header">
                <h2>Database Connections</h2>
                <button className="db-btn db-btn-primary" onClick={onNew}>+ New Connection</button>
            </div>
            <div className="db-conn-list">
                {loading && <div className="db-loading">Loading…</div>}
                {!loading && conns.length === 0 && (
                    <div className="db-conn-empty">No connections yet. Create one to get started.</div>
                )}
                {conns.map(conn => (
                    <ConnCard
                        key={conn.id}
                        conn={conn}
                        connected={!!status[conn.id]}
                        onConnect={() => onConnect(conn.id)}
                        onDisconnect={() => onDisconnect(conn.id)}
                        onEdit={() => onEdit(conn)}
                        onDelete={() => onDelete(conn.id)}
                        onOpen={() => onOpen(conn)}
                    />
                ))}
            </div>
        </div>
    );
}

// ── Connection form view ──────────────────────────────────────────────────────

interface ConnectionFormViewProps {
    initial: Conn | null;
    onSave: (conn: Conn, password: string, sshPassword: string) => void;
    onCancel: () => void;
}

function ConnectionFormView({ initial, onSave, onCancel }: ConnectionFormViewProps) {
    const [form, setForm] = useState<Conn>(initial ? { ...initial } : emptyConn());
    const [password, setPassword] = useState('');
    const [sshPassword, setSSHPassword] = useState('');
    const [testState, setTestState] = useState<{ ok: boolean; msg: string } | null>(null);
    const [testing, setTesting] = useState(false);

    const set = (patch: Partial<Conn>) => setForm(f => ({ ...f, ...patch }));

    const handleDriverChange = (driver: string) => {
        set({ driver, port: DEFAULT_PORTS[driver] || 5432 });
    };

    const handleTest = async () => {
        setTesting(true);
        setTestState(null);
        try {
            const res = await fetch('/api/plugin/db/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection: form, password, sshPassword }),
            });
            const data = await res.json() as { ok: boolean; error?: string };
            setTestState({ ok: data.ok, msg: data.ok ? 'Connection successful!' : (data.error ?? 'Failed') });
        } catch (e) {
            setTestState({ ok: false, msg: String(e) });
        } finally {
            setTesting(false);
        }
    };

    const isSQLite = form.driver === 'sqlite';
    const isMongo = form.driver === 'mongo';
    const needsSSH = form.method !== 'direct';
    const needsSSHPass = form.method === 'ssh';
    const needsSSHKey = form.method === 'ssh-key';

    return (
        <div className="db-root">
            <div className="db-form-header">
                <button className="db-btn db-btn-ghost" onClick={onCancel}>← Back</button>
                <h2>{initial?.id ? 'Edit Connection' : 'New Connection'}</h2>
            </div>

            <div className="db-form-body">
                {/* Label */}
                <div className="db-field">
                    <label>Label</label>
                    <input value={form.label} onChange={e => set({ label: e.target.value })} placeholder="My Database" />
                </div>

                {/* Driver + Method */}
                <div className="db-field-row">
                    <div className="db-field">
                        <label>Driver</label>
                        <select value={form.driver} onChange={e => handleDriverChange(e.target.value)}>
                            <option value="postgres">PostgreSQL</option>
                            <option value="mysql">MySQL / MariaDB</option>
                            <option value="sqlite">SQLite</option>
                            <option value="mongo">MongoDB</option>
                        </select>
                    </div>
                    {!isSQLite && (
                        <div className="db-field">
                            <label>Connection method</label>
                            <select value={form.method} onChange={e => set({ method: e.target.value })}>
                                <option value="direct">Direct TCP</option>
                                <option value="ssh">SSH Tunnel (password)</option>
                                <option value="ssh-key">SSH Tunnel (key file)</option>
                            </select>
                        </div>
                    )}
                </div>

                {/* SQLite: file path only */}
                {isSQLite && (
                    <div className="db-field">
                        <label>File path</label>
                        <input value={form.filePath} onChange={e => set({ filePath: e.target.value })} placeholder="/path/to/database.db" />
                    </div>
                )}

                {/* Non-SQLite: host/port/database/user */}
                {!isSQLite && (
                    <>
                        <div className="db-field-row">
                            <div className="db-field">
                                <label>Host</label>
                                <input value={form.host} onChange={e => set({ host: e.target.value })} placeholder="localhost" />
                            </div>
                            <div className="db-field db-field-port">
                                <label>Port</label>
                                <input type="number" value={form.port || ''} onChange={e => set({ port: parseInt(e.target.value) || 0 })} />
                            </div>
                        </div>

                        <div className="db-field-row">
                            <div className="db-field">
                                <label>Database</label>
                                <input value={form.database} onChange={e => set({ database: e.target.value })} placeholder="mydb" />
                            </div>
                            <div className="db-field">
                                <label>Username</label>
                                <input value={form.user} onChange={e => set({ user: e.target.value })} placeholder="postgres" />
                            </div>
                        </div>

                        <div className="db-field">
                            <label>Password</label>
                            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="(stored encrypted)" />
                        </div>

                        {!isMongo && (
                            <div className="db-field">
                                <label>SSL mode</label>
                                <select value={form.sslMode} onChange={e => set({ sslMode: e.target.value })}>
                                    <option value="disable">Disable</option>
                                    <option value="require">Require</option>
                                    <option value="verify-full">Verify Full</option>
                                </select>
                            </div>
                        )}
                    </>
                )}

                {/* SSH section */}
                {needsSSH && (
                    <div className="db-form-section">
                        <div className="db-form-section-title">SSH Tunnel</div>

                        <div className="db-field-row">
                            <div className="db-field">
                                <label>SSH host</label>
                                <input value={form.sshHost} onChange={e => set({ sshHost: e.target.value })} placeholder="bastion.example.com" />
                            </div>
                            <div className="db-field db-field-port">
                                <label>SSH port</label>
                                <input type="number" value={form.sshPort || 22} onChange={e => set({ sshPort: parseInt(e.target.value) || 22 })} />
                            </div>
                        </div>

                        <div className="db-field">
                            <label>SSH username</label>
                            <input value={form.sshUser} onChange={e => set({ sshUser: e.target.value })} placeholder="ubuntu" />
                        </div>

                        {needsSSHPass && (
                            <div className="db-field">
                                <label>SSH password</label>
                                <input type="password" value={sshPassword} onChange={e => setSSHPassword(e.target.value)} placeholder="(stored encrypted)" />
                            </div>
                        )}

                        {needsSSHKey && (
                            <div className="db-field">
                                <label>SSH key path (server-side)</label>
                                <input value={form.sshKeyPath} onChange={e => set({ sshKeyPath: e.target.value })} placeholder="/home/user/.ssh/id_rsa" />
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="db-form-footer">
                {testState && (
                    <div className={`db-test-result ${testState.ok ? 'db-test-ok' : 'db-test-err'}`}>
                        {testState.ok ? '✓' : '✗'} {testState.msg}
                    </div>
                )}
                <button className="db-btn" onClick={handleTest} disabled={testing}>
                    {testing ? 'Testing…' : 'Test Connection'}
                </button>
                <button className="db-btn db-btn-primary" onClick={() => onSave(form, password, sshPassword)}>
                    {initial?.id ? 'Save Changes' : 'Save'}
                </button>
            </div>
        </div>
    );
}

// ── Schema tree ───────────────────────────────────────────────────────────────

interface SchemaTreeProps {
    schema: SchemaDatabase[];
    loading: boolean;
    onSelectTable: (dbName: string, table: SchemaTable) => void;
    selectedTable: string;
    onRefresh: () => void;
}

function SchemaTree({ schema, loading, onSelectTable, selectedTable, onRefresh }: SchemaTreeProps) {
    const [openDBs, setOpenDBs] = useState<Set<string>>(new Set());
    const [openTables, setOpenTables] = useState<Set<string>>(new Set());

    // Auto-open first database on load
    useEffect(() => {
        if (schema.length > 0) {
            setOpenDBs(new Set([schema[0].name]));
        }
    }, [schema]);

    const toggleDB = (name: string) => {
        setOpenDBs(s => {
            const n = new Set(s);
            if (n.has(name)) n.delete(name); else n.add(name);
            return n;
        });
    };

    const toggleTable = (key: string) => {
        setOpenTables(s => {
            const n = new Set(s);
            if (n.has(key)) n.delete(key); else n.add(key);
            return n;
        });
    };

    return (
        <div className="db-schema-tree">
            <div className="db-schema-tree-header">
                <span>Schema</span>
                <button className="db-btn db-btn-ghost" style={{ padding: '2px 6px', fontSize: '12px' }} onClick={onRefresh} title="Refresh schema">↺</button>
            </div>
            {loading && <div className="db-tree-loading">Loading schema…</div>}
            {!loading && schema.map(db => (
                <div key={db.name} className="db-tree-node">
                    <div
                        className="db-tree-node-label db-tree-level-0"
                        onClick={() => toggleDB(db.name)}
                    >
                        <span className={`db-tree-caret ${openDBs.has(db.name) ? 'db-open' : ''}`}>▶</span>
                        <span className="db-tree-icon">⊞</span>
                        <span>{db.name}</span>
                    </div>
                    {openDBs.has(db.name) && db.tables.map(table => {
                        const tableKey = `${db.name}.${table.name}`;
                        const hasColumns = (table.columns ?? []).length > 0;
                        const isSelected = selectedTable === tableKey;
                        return (
                            <div key={tableKey} className="db-tree-node">
                                <div
                                    className={`db-tree-node-label db-tree-level-1 db-tree-type-${table.type} ${isSelected ? 'db-tree-selected' : ''}`}
                                    onClick={() => {
                                        if (hasColumns) toggleTable(tableKey);
                                        onSelectTable(db.name, table);
                                    }}
                                >
                                    {hasColumns && (
                                        <span className={`db-tree-caret ${openTables.has(tableKey) ? 'db-open' : ''}`}>▶</span>
                                    )}
                                    {!hasColumns && <span className="db-tree-icon"> </span>}
                                    <span className="db-tree-icon">{table.type === 'view' ? '◫' : table.type === 'collection' ? '◉' : '▦'}</span>
                                    <span>{table.name}</span>
                                </div>
                                {openTables.has(tableKey) && (table.columns ?? []).map(col => (
                                    <div key={col.name} className="db-tree-node-label db-tree-level-2">
                                        <span className="db-tree-icon">◌</span>
                                        <span>{col.name}</span>
                                        <span className="db-type-hint">{col.dataType}</span>
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

// ── Results grid (virtual scroll) ─────────────────────────────────────────────

const ROW_HEIGHT = 24;
const OVERSCAN = 20;

interface ResultsGridProps {
    result: QueryResult | null;
    loading: boolean;
}

function ResultsGrid({ result, loading }: ResultsGridProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(300);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setHeight(el.clientHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const handleScroll = useCallback(() => {
        if (wrapRef.current) setScrollTop(wrapRef.current.scrollTop);
    }, []);

    if (loading) {
        return (
            <div className="db-results-wrap">
                <div className="db-results-empty">Running query…</div>
                <div className="db-status-bar"><span>Running…</span></div>
            </div>
        );
    }

    if (!result) {
        return (
            <div className="db-results-wrap">
                <div className="db-results-empty">Run a query to see results</div>
                <div className="db-status-bar"><span>Ready</span></div>
            </div>
        );
    }

    if (result.error) {
        return (
            <div className="db-results-wrap">
                <div className="db-results-empty" style={{ flexDirection: 'column', gap: 8, color: '#e06c75', padding: 16 }}>
                    <strong>Query error</strong>
                    <code style={{ fontSize: 11, opacity: 0.85 }}>{result.error}</code>
                </div>
                <div className="db-status-bar"><span className="db-status-err">Error</span></div>
            </div>
        );
    }

    const rows = result.rows;
    const totalHeight = rows.length * ROW_HEIGHT;
    const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleEnd = Math.min(rows.length, visibleStart + Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2);
    const topPad = visibleStart * ROW_HEIGHT;
    const bottomPad = Math.max(0, (rows.length - visibleEnd) * ROW_HEIGHT);

    return (
        <div className="db-results-wrap">
            <div
                className="db-grid-wrap"
                ref={wrapRef}
                onScroll={handleScroll}
            >
                <table className="db-grid">
                    <thead className="db-grid-header">
                        <tr>
                            {result.columns.map(col => (
                                <th key={col} className="db-grid-th">{col}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {topPad > 0 && (
                            <tr className="db-grid-spacer" style={{ height: topPad }}>
                                <td colSpan={result.columns.length} style={{ padding: 0, border: 'none' }} />
                            </tr>
                        )}
                        {rows.slice(visibleStart, visibleEnd).map((row, rIdx) => {
                            const absIdx = visibleStart + rIdx;
                            return (
                                <tr key={absIdx} className={`db-grid-row ${absIdx % 2 === 1 ? 'db-row-even' : ''}`} style={{ height: ROW_HEIGHT }}>
                                    {(row as unknown[]).map((cell, cIdx) => (
                                        <td key={cIdx} className={`db-grid-cell ${cell === null ? 'db-cell-null' : ''}`}>
                                            {cell === null ? 'NULL' : String(cell)}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                        {bottomPad > 0 && (
                            <tr className="db-grid-spacer" style={{ height: bottomPad }}>
                                <td colSpan={result.columns.length} style={{ padding: 0, border: 'none' }} />
                            </tr>
                        )}
                    </tbody>
                </table>
                {rows.length === 0 && !result.error && (
                    <div className="db-results-empty" style={{ height: Math.max(60, height - 40) }}>
                        Query returned 0 rows
                    </div>
                )}
            </div>
            <div className="db-status-bar">
                <span className="db-status-ok">{result.rowCount.toLocaleString()} rows</span>
                <span>·</span>
                <span>{result.durationMs}ms</span>
                {rows.length === 10000 && <span style={{ color: '#e5c07b' }}>· (capped at 10 000)</span>}
            </div>
        </div>
    );
}

// ── SQL editor ────────────────────────────────────────────────────────────────

interface SqlEditorProps {
    isMongo: boolean;
    sql: string;
    onSqlChange: (s: string) => void;
    limit: number;
    onLimitChange: (n: number) => void;
    onRun: () => void;
    running: boolean;
}

function SqlEditor({ isMongo, sql, onSqlChange, limit, onLimitChange, onRun, running }: SqlEditorProps) {
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            onRun();
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.currentTarget;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const newVal = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
            onSqlChange(newVal);
            // Restore cursor position after React re-render
            requestAnimationFrame(() => {
                ta.selectionStart = ta.selectionEnd = start + 2;
            });
        }
    };

    return (
        <div className="db-editor-wrap">
            <div className="db-editor-toolbar">
                <span className="db-editor-label">{isMongo ? 'Query (JSON filter)' : 'SQL'}</span>
                <div className="db-editor-spacer" />
                <span style={{ fontSize: 11, color: 'var(--ui-text-muted)' }}>Ctrl+Enter to run</span>
                <select
                    className="db-limit-select"
                    value={limit}
                    onChange={e => onLimitChange(parseInt(e.target.value))}
                >
                    <option value={100}>100 rows</option>
                    <option value={500}>500 rows</option>
                    <option value={1000}>1 000 rows</option>
                    <option value={5000}>5 000 rows</option>
                </select>
                <button className="db-btn db-btn-primary" onClick={onRun} disabled={running}>
                    {running ? 'Running…' : '▶ Run'}
                </button>
            </div>
            <textarea
                className="db-textarea"
                value={sql}
                onChange={e => onSqlChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isMongo ? '{ "field": "value" }' : 'SELECT * FROM your_table LIMIT 100'}
                spellCheck={false}
            />
        </div>
    );
}

// ── Workspace view ────────────────────────────────────────────────────────────

interface WorkspaceViewProps {
    conn: Conn;
    onDisconnect: () => void;
}

function WorkspaceView({ conn, onDisconnect }: WorkspaceViewProps) {
    const [schema, setSchema] = useState<SchemaDatabase[]>([]);
    const [schemaLoading, setSchemaLoading] = useState(true);
    const [selectedTable, setSelectedTable] = useState('');
    const [mongoCollection, setMongoCollection] = useState('');
    const [sql, setSql] = useState('');
    const [limit, setLimit] = useState(100);
    const [result, setResult] = useState<QueryResult | null>(null);
    const [running, setRunning] = useState(false);

    const isMongo = conn.driver === 'mongo';

    const loadSchema = useCallback(() => {
        setSchemaLoading(true);
        fetch(`/api/plugin/db/schema?conn=${encodeURIComponent(conn.id)}`)
            .then(r => r.json())
            .then((data: { schema: SchemaDatabase[] }) => setSchema(data.schema ?? []))
            .catch(() => setSchema([]))
            .finally(() => setSchemaLoading(false));
    }, [conn.id]);

    useEffect(() => {
        loadSchema();
    }, [loadSchema]);

    const handleSelectTable = useCallback((_dbName: string, table: SchemaTable) => {
        const key = `${_dbName}.${table.name}`;
        setSelectedTable(key);

        if (isMongo) {
            setMongoCollection(table.name);
            // For MongoDB, auto-run with empty filter
            setSql('{}');
            runQuery('{}', table.name, limit);
        } else {
            // Auto-run SELECT * LIMIT 100
            const q = `SELECT * FROM ${table.name} LIMIT ${limit}`;
            setSql(q);
            runQuery(q, '', limit);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conn.id, isMongo, limit]);

    const runQuery = useCallback((querySQL: string, collName: string, rowLimit: number) => {
        setRunning(true);
        setResult(null);
        fetch('/api/plugin/db/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conn: conn.id,
                sql: querySQL,
                limit: rowLimit,
                collection: collName || mongoCollection,
            }),
        })
            .then(r => r.json())
            .then((data: QueryResult) => setResult(data))
            .catch(e => setResult({ columns: [], rows: [], rowCount: 0, durationMs: 0, error: String(e) }))
            .finally(() => setRunning(false));
    }, [conn.id, mongoCollection]);

    const handleRun = useCallback(() => {
        runQuery(sql, mongoCollection, limit);
    }, [sql, mongoCollection, limit, runQuery]);

    return (
        <div className="db-root">
            <div className="db-workspace-toolbar">
                <button className="db-btn db-btn-ghost" onClick={onDisconnect} title="Disconnect and go back">← Back</button>
                <span className="db-workspace-name">{conn.label || '(unnamed)'}</span>
                <DriverBadge driver={conn.driver} />
                <div style={{ flex: 1 }} />
                <button className="db-btn db-btn-ghost db-btn-danger" onClick={onDisconnect}>Disconnect</button>
            </div>

            <div className="db-workspace">
                <SchemaTree
                    schema={schema}
                    loading={schemaLoading}
                    onSelectTable={handleSelectTable}
                    selectedTable={selectedTable}
                    onRefresh={loadSchema}
                />

                <div className="db-right-panel">
                    <SqlEditor
                        isMongo={isMongo}
                        sql={sql}
                        onSqlChange={setSql}
                        limit={limit}
                        onLimitChange={setLimit}
                        onRun={handleRun}
                        running={running}
                    />
                    <ResultsGrid result={result} loading={running} />
                </div>
            </div>
        </div>
    );
}

// ── Main DatabasePane ─────────────────────────────────────────────────────────

function DatabasePane(_props: PluginPaneProps) {
    const [view, setView] = useState<View>('list');
    const [conns, setConns] = useState<Conn[]>([]);
    const [status, setStatus] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [editConn, setEditConn] = useState<Conn | null>(null);
    const [activeConn, setActiveConn] = useState<Conn | null>(null);
    const [connectError, setConnectError] = useState<string | null>(null);

    const loadConns = useCallback(() => {
        setLoading(true);
        fetch('/api/plugin/db/connections')
            .then(r => r.json())
            .then((d: { connections: Conn[] }) => setConns(d.connections ?? []))
            .catch(() => setConns([]))
            .finally(() => setLoading(false));
    }, []);

    const loadStatus = useCallback(() => {
        fetch('/api/plugin/db/status')
            .then(r => r.json())
            .then((s: Record<string, boolean>) => setStatus(s))
            .catch(() => {});
    }, []);

    useEffect(() => {
        loadConns();
        loadStatus();
    }, [loadConns, loadStatus]);

    // Refresh status every 10 seconds
    useEffect(() => {
        const id = setInterval(loadStatus, 10_000);
        return () => clearInterval(id);
    }, [loadStatus]);

    const handleNew = () => {
        setEditConn(null);
        setView('form');
    };

    const handleEdit = (conn: Conn) => {
        setEditConn(conn);
        setView('form');
    };

    const handleDelete = async (id: string) => {
        await fetch(`/api/plugin/db/connections/${id}`, { method: 'DELETE' });
        loadConns();
        loadStatus();
    };

    const handleSave = async (conn: Conn, password: string, sshPassword: string) => {
        if (conn.id) {
            // Update existing
            await fetch(`/api/plugin/db/connections/${conn.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection: conn, password, sshPassword }),
            });
        } else {
            // Create new
            await fetch('/api/plugin/db/connections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection: conn, password, sshPassword }),
            });
        }
        loadConns();
        setView('list');
    };

    const handleConnect = async (id: string) => {
        setConnectError(null);
        const res = await fetch('/api/plugin/db/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (data.error) {
            setConnectError(data.error);
        } else {
            loadStatus();
        }
    };

    const handleDisconnect = async (id: string) => {
        await fetch('/api/plugin/db/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (activeConn?.id === id) {
            setActiveConn(null);
            setView('list');
        }
        loadStatus();
    };

    const handleOpen = (conn: Conn) => {
        setActiveConn(conn);
        setView('workspace');
    };

    const handleConnectAndOpen = async (id: string) => {
        setConnectError(null);
        const res = await fetch('/api/plugin/db/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (data.error) {
            setConnectError(data.error);
        } else {
            await loadStatus();
            const c = conns.find(c => c.id === id);
            if (c) handleOpen(c);
        }
    };

    if (view === 'workspace' && activeConn) {
        return (
            <WorkspaceView
                conn={activeConn}
                onDisconnect={() => {
                    handleDisconnect(activeConn.id);
                    setView('list');
                    setActiveConn(null);
                }}
            />
        );
    }

    if (view === 'form') {
        return (
            <ConnectionFormView
                initial={editConn}
                onSave={handleSave}
                onCancel={() => setView('list')}
            />
        );
    }

    return (
        <>
            {connectError && (
                <div style={{ padding: '4px 14px' }}>
                    <div className="db-error-banner">
                        Connection failed: {connectError}
                        <button
                            onClick={() => setConnectError(null)}
                            style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                        >✕</button>
                    </div>
                </div>
            )}
            <ConnectionListView
                conns={conns}
                status={status}
                loading={loading}
                onNew={handleNew}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onConnect={handleConnectAndOpen}
                onDisconnect={handleDisconnect}
                onOpen={handleOpen}
            />
        </>
    );
}

// ── Register ──────────────────────────────────────────────────────────────────

registerPlugin({
    id: 'db',
    title: 'Database',
    iconClass: 'devicon-postgresql-plain colored',
    component: DatabasePane,
});
