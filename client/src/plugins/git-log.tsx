import { useState, useEffect, useCallback } from 'react';
import { registerPlugin } from './registry';
import type { PluginPaneProps } from './registry';
import '../style/plugin-git-log.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Commit {
    hash: string;
    short: string;
    author: string;
    date: string;
    refs: string[];
    subject: string;
}

interface LogResponse {
    is_repo: boolean;
    branch: string;
    commits: Commit[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
}

function refClass(ref: string): string {
    if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'gl-ref-head';
    if (ref.startsWith('tag:')) return 'gl-ref-tag';
    if (ref.startsWith('origin/') || ref.startsWith('upstream/')) return 'gl-ref-remote';
    return 'gl-ref-branch';
}

function refLabel(ref: string): string {
    if (ref.startsWith('HEAD -> ')) return ref.slice(8);
    if (ref.startsWith('tag: ')) return '🏷 ' + ref.slice(5);
    return ref;
}

// ── Diff renderer ─────────────────────────────────────────────────────────────

function DiffView({ lines }: { lines: string[] }) {
    return (
        <pre className="gl-diff-pre">
            {lines.map((line, i) => {
                if (line.startsWith('+++') || line.startsWith('---') ||
                    line.startsWith('diff ') || line.startsWith('index ') ||
                    line.startsWith('new file') || line.startsWith('deleted file') ||
                    line.startsWith('rename ') || line.startsWith('similarity ')) {
                    return <span key={i} className="gl-diff-line-file">{line}{'\n'}</span>;
                }
                if (line.startsWith('@@')) {
                    return <span key={i} className="gl-diff-line-hunk">{line}{'\n'}</span>;
                }
                if (line.startsWith('+')) {
                    return <span key={i} className="gl-diff-line-add">{line}{'\n'}</span>;
                }
                if (line.startsWith('-')) {
                    return <span key={i} className="gl-diff-line-del">{line}{'\n'}</span>;
                }
                return <span key={i}>{line}{'\n'}</span>;
            })}
        </pre>
    );
}

// ── Main pane ─────────────────────────────────────────────────────────────────

function GitLogPane(_props: PluginPaneProps) {
    const [log, setLog] = useState<LogResponse | null>(null);
    const [branches, setBranches] = useState<string[]>([]);
    const [selectedBranch, setSelectedBranch] = useState('');
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [diffLines, setDiffLines] = useState<string[] | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadLog = useCallback((branch?: string) => {
        setLoading(true);
        setError(null);
        const url = branch
            ? `/api/plugin/git-log/commits?branch=${encodeURIComponent(branch)}`
            : '/api/plugin/git-log/commits';
        fetch(url)
            .then(r => r.json())
            .then((d: LogResponse) => {
                setLog(d);
                if (d.branch && !branch) setSelectedBranch(d.branch);
            })
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const loadBranches = useCallback(() => {
        fetch('/api/plugin/git-log/branches')
            .then(r => r.json())
            .then(d => setBranches(d.branches ?? []))
            .catch(() => {});
    }, []);

    useEffect(() => {
        loadLog();
        loadBranches();
    }, [loadLog, loadBranches]);

    const handleSelectCommit = useCallback((hash: string) => {
        if (hash === selectedHash) return;
        setSelectedHash(hash);
        setDiffLines(null);
        setDiffLoading(true);
        fetch(`/api/plugin/git-log/diff?hash=${encodeURIComponent(hash)}`)
            .then(r => r.json())
            .then(d => setDiffLines((d.diff as string).split('\n')))
            .catch(() => setDiffLines(['(failed to load diff)']))
            .finally(() => setDiffLoading(false));
    }, [selectedHash]);

    const handleBranchChange = useCallback((branch: string) => {
        setSelectedBranch(branch);
        setSelectedHash(null);
        setDiffLines(null);
        if (branch === '') {
            loadLog();
        } else {
            // Checkout the branch first, then reload
            fetch('/api/plugin/git-log/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch }),
            }).then(() => loadLog(branch)).catch(() => loadLog(branch));
        }
    }, [loadLog]);

    const selectedCommit = log?.commits.find(c => c.hash === selectedHash) ?? null;

    // ── Render ────────────────────────────────────────────────────────

    if (error) {
        return <div className="gl-root"><div className="gl-empty">Error: {error}</div></div>;
    }

    if (!log?.is_repo) {
        return (
            <div className="gl-root">
                <div className="gl-empty">
                    {loading ? 'Loading…' : 'Not a git repository'}
                </div>
            </div>
        );
    }

    return (
        <div className="gl-root">
            {/* ── Left: commit list ── */}
            <div className="gl-sidebar">
                <div className="gl-toolbar">
                    <span className="gl-branch-label">Branch</span>
                    <select
                        className="gl-branch-select"
                        value={selectedBranch}
                        onChange={e => handleBranchChange(e.target.value)}
                    >
                        {branches.map(b => (
                            <option key={b} value={b}>{b}</option>
                        ))}
                    </select>
                    <button
                        className="gl-refresh-btn"
                        onClick={() => { loadLog(); loadBranches(); }}
                        title="Refresh"
                    >
                        ↺
                    </button>
                </div>

                <div className="gl-list">
                    {loading && <div className="gl-empty">Loading…</div>}
                    {!loading && log.commits.length === 0 && (
                        <div className="gl-empty">No commits</div>
                    )}
                    {log.commits.map(c => (
                        <div
                            key={c.hash}
                            className={`gl-commit ${c.hash === selectedHash ? 'gl-selected' : ''}`}
                            onClick={() => handleSelectCommit(c.hash)}
                        >
                            <div className="gl-commit-top">
                                <span className="gl-hash">{c.short}</span>
                                {c.refs.length > 0 && (
                                    <span className="gl-refs">
                                        {c.refs.map((ref, i) => (
                                            <span key={i} className={`gl-ref ${refClass(ref)}`}>
                                                {refLabel(ref)}
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </div>
                            <div className="gl-subject">{c.subject}</div>
                            <div className="gl-commit-meta">
                                <span className="gl-author">{c.author}</span>
                                <span className="gl-date">{relativeTime(c.date)}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── Right: diff viewer ── */}
            <div className="gl-main">
                {!selectedCommit ? (
                    <div className="gl-placeholder">Select a commit to view diff</div>
                ) : (
                    <>
                        <div className="gl-diff-header">
                            <div>
                                <span className="gl-diff-hash">{selectedCommit.short}</span>
                                <span className="gl-diff-subject">{selectedCommit.subject}</span>
                            </div>
                            <div className="gl-diff-meta">
                                {selectedCommit.author} · {new Date(selectedCommit.date).toLocaleString()}
                            </div>
                        </div>
                        <div className="gl-diff-body">
                            {diffLoading && <div className="gl-placeholder">Loading diff…</div>}
                            {!diffLoading && diffLines && <DiffView lines={diffLines} />}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

// ── Register ──────────────────────────────────────────────────────────────────

registerPlugin({
    id: 'git-log',
    title: 'Git Log',
    iconClass: 'devicon-git-plain colored',
    component: GitLogPane,
});
