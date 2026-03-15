/**
 * PtyManager — manages a Map of PTY instances (nvim editors and $SHELL terminals).
 *
 * Each instance is identified by a PtyInstanceId (UUID v4 generated client-side).
 * Editor PTYs spawn nvim with a --listen socket; terminal PTYs spawn $SHELL.
 * The first editor PTY is tracked as "primary" for buffer-watch and /api/nvim-open.
 */

import { spawn, IPty } from 'node-pty';
import { MineoCfg, loadConfig } from './config';
import * as path from 'path';
import * as fs from 'fs';

type PtyInstanceId = string;
type PaneRole = 'neovim' | 'terminal' | 'monaco';

const CONFIG_PATH = process.env.MINEO_CONFIG || path.resolve(__dirname, '../../../config.json');
let cfg = loadConfig(CONFIG_PATH);

// Bundled nvim config lives at <repo-root>/nvim-config/
// __dirname at runtime: <root>/server/dist/ → two levels up = <root>/
const BUNDLED_CONFIG_DIR = path.resolve(__dirname, '../../nvim-config');

/**
 * Build the extra env vars to apply based on the configured nvim config mode.
 *  - 'system':  no override — nvim reads ~/.config/nvim as usual
 *  - 'bundled': point XDG_CONFIG_HOME at the in-app nvim-config directory
 *  - 'custom':  point XDG_CONFIG_HOME at the user-supplied configDir
 */
function nvimConfigEnv(): Record<string, string> {
  const mode = cfg.nvim.configMode ?? 'system';
  if (mode === 'bundled') {
    return { XDG_CONFIG_HOME: BUNDLED_CONFIG_DIR };
  }
  if (mode === 'custom' && cfg.nvim.configDir) {
    return { XDG_CONFIG_HOME: cfg.nvim.configDir };
  }
  return {};
}

/**
 * ISO 8613-6 colon-separated RGB → legacy semicolon-separated.
 * xterm.js only understands the semicolon form.
 */
const COLON_RGB_RE = /\x1b\[(\d+):2:(\d+):(\d+):(\d+)m/g;

type DataListener = (data: string) => void;

interface PtyInstance {
    pty: IPty;
    role: PaneRole;
    socketPath: string | undefined; // only for editor PTYs
    listeners: Set<DataListener>;
    disposed: boolean;
}

export class PtyManager {
    private instances = new Map<PtyInstanceId, PtyInstance>();
    private primaryId: PtyInstanceId | undefined;

    /**
     * Spawn a new PTY instance.
     * - role='neovim': spawns nvim with --listen socket
     * - role='terminal': spawns $SHELL (bash/zsh)
     */
    spawn(id: PtyInstanceId, role: PaneRole, cols: number, rows: number, cwd?: string): void {
        if (this.instances.has(id)) {
            throw new Error(`PTY instance ${id} already exists`);
        }

        // Use provided cwd if it's a valid absolute path that exists, else fall back to cfg.workspace
        const resolvedCwd = (cwd && cwd.startsWith('/') && fs.existsSync(cwd)) ? cwd : cfg.workspace;

        let pty: IPty;
        let socketPath: string | undefined;

        if (role === 'neovim') {
            socketPath = `/tmp/mineo-nvim-${id}.sock`;
            // Remove stale socket file before spawning
            try { fs.unlinkSync(socketPath); } catch { /* doesn't exist — fine */ }

            pty = spawn(cfg.nvim.bin, ['--listen', socketPath, '-c', 'set mouse=a'], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: resolvedCwd,
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    ...nvimConfigEnv(),
                } as Record<string, string>,
            });

            // Track first editor as primary
            if (!this.primaryId) {
                this.primaryId = id;
            }
        } else {
            // Terminal — spawn user's shell
            const shell = process.env.SHELL || '/bin/bash';
            pty = spawn(shell, [], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: resolvedCwd,
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                } as Record<string, string>,
            });
        }

        const listeners: Set<DataListener> = new Set();
        const instance: PtyInstance = { pty, role, socketPath, listeners, disposed: false };

        // PTY stdout → listeners (with RGB translation for editor PTYs)
        pty.onData((data: any) => {
            if (instance.disposed) return;
            const str: string = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
            const translated = role === 'neovim'
                ? str.replace(COLON_RGB_RE, '\x1b[$1;2;$2;$3;$4m')
                : str;
            for (const cb of instance.listeners) {
                cb(translated);
            }
        });

        // Handle PTY exit
        pty.onExit(() => {
            this.cleanup(id);
        });

        this.instances.set(id, instance);
    }

    /** Write data to a PTY's stdin. */
    write(id: PtyInstanceId, data: string | Buffer): void {
        const inst = this.instances.get(id);
        if (inst && !inst.disposed) {
            inst.pty.write(data as any);
        }
    }

    /** Resize a PTY. */
    resize(id: PtyInstanceId, cols: number, rows: number): void {
        const inst = this.instances.get(id);
        if (inst && !inst.disposed && cols > 0 && rows > 0) {
            inst.pty.resize(cols, rows);
        }
    }

    /**
     * Subscribe to data events from a PTY.
     * Returns an unsubscribe function (for ws-pty.ts compatibility).
     */
    onData(id: PtyInstanceId, cb: (data: string) => void): () => void {
        const inst = this.instances.get(id);
        if (!inst) return () => { /* no-op */ };
        inst.listeners.add(cb);
        return () => { inst.listeners.delete(cb); };
    }

    /** Kill a PTY instance. */
    kill(id: PtyInstanceId): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.disposed = true;
        try { inst.pty.kill(); } catch { /* already dead */ }
        this.cleanup(id);
    }

    /** Check if an instance exists. */
    has(id: PtyInstanceId): boolean {
        return this.instances.has(id);
    }

    /** Get the role of an instance. */
    getRole(id: PtyInstanceId): PaneRole | undefined {
        return this.instances.get(id)?.role;
    }

    /** Get the socket path for the primary (first editor) PTY. */
    getPrimarySocketPath(): string | undefined {
        if (!this.primaryId) return undefined;
        return this.instances.get(this.primaryId)?.socketPath;
    }

    /** Get the primary instance ID. */
    getPrimaryId(): PtyInstanceId | undefined {
        return this.primaryId;
    }

    /** Get the nvim binary path (for buffer-watch execFile). */
    getNvimBin(): string {
        return cfg.nvim.bin;
    }

    /** Get current nvim config info for the settings API. */
    getNvimConfigInfo(): { bin: string; configMode: string; configDir: string; bundledConfigDir: string } {
        return {
            bin: cfg.nvim.bin,
            configMode: cfg.nvim.configMode ?? 'system',
            configDir: cfg.nvim.configDir ?? '',
            bundledConfigDir: BUNDLED_CONFIG_DIR,
        };
    }

    /**
     * Reload config — accepts an already-loaded MineoCfg snapshot,
     * or re-reads from disk if called with no arguments.
     */
    reloadConfig(freshCfg?: MineoCfg): void {
        const next = freshCfg ?? loadConfig(CONFIG_PATH);
        cfg.nvim.bin = next.nvim.bin;
        cfg.nvim.configMode = next.nvim.configMode;
        cfg.nvim.configDir = next.nvim.configDir;
    }

    /** Get the socket path for an instance. */
    getSocketPath(id: PtyInstanceId): string | undefined {
        return this.instances.get(id)?.socketPath;
    }

    /** Dispose all PTY instances — called on server shutdown. */
    disposeAll(): void {
        for (const [id] of this.instances) {
            this.kill(id);
        }
    }

    private cleanup(id: PtyInstanceId): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.disposed = true;
        inst.listeners.clear();
        // Clean up socket file for editor PTYs
        if (inst.socketPath) {
            try { fs.unlinkSync(inst.socketPath); } catch { /* fine */ }
        }
        this.instances.delete(id);
        // If primary was killed, promote next editor
        if (this.primaryId === id) {
            this.primaryId = undefined;
            for (const [nextId, nextInst] of this.instances) {
                if (nextInst.role === 'neovim' && !nextInst.disposed) {
                    this.primaryId = nextId;
                    break;
                }
            }
        }
    }
}

export const ptyManager = new PtyManager();
