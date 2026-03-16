import { useState, useEffect } from 'react';

export type GitStatusMap = Map<string, string>; // workspace-relative path → xy status

export function useGitStatus(pollMs = 5000) {
    const [statusMap, setStatusMap] = useState<GitStatusMap>(new Map());
    const [branch, setBranch] = useState('');

    useEffect(() => {
        let cancelled = false;
        async function fetch_() {
            try {
                const res = await fetch('/api/git/status');
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (!data.is_repo) return;
                setBranch(data.branch ?? '');
                const m = new Map<string, string>();
                for (const f of (data.files ?? [])) m.set(f.path, f.status);
                setStatusMap(m);
            } catch { /* network hiccup */ }
        }
        fetch_();
        const id = setInterval(fetch_, pollMs);
        return () => { cancelled = true; clearInterval(id); };
    }, [pollMs]);

    return { statusMap, branch };
}
