import * as express from 'express';
import * as path from 'path';
import * as os from 'os';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { loadConfig, saveConfig, saveNvimConfig, MineoCfg } from './config';
import { ptyManager } from './pty-manager';
import { checkNvimReady } from './nvim-ready';

const execFileAsync = promisify(execFile);

const CONFIG_PATH = process.env.MINEO_CONFIG || path.join(__dirname, '../../../config.json');

export function registerApiRoutes(app: express.Application, cfg: MineoCfg): void {
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

    app.get('/api/workspace', (_req, res) => res.json({ workspace: cfg.workspace }));

    // /api/config — GET returns full user-editable config snapshot
    // POST saves workspace / password fields and hot-reloads cfg.
    app.get('/api/config', (_req, res) => res.json({
        workspace: cfg.workspace,
        hasPassword: !!cfg.password,
        password: cfg.password ? '••••••••' : '',
    }));

    app.post('/api/config', express.json(), (req, res) => {
        try {
            const body = req.body as Record<string, unknown>;
            const patch: Partial<{ workspace: string; password: string }> = {};

            if ('workspace' in body) {
                if (typeof body.workspace !== 'string' || !body.workspace.trim()) {
                    res.status(400).json({ error: 'workspace must be a non-empty string' });
                    return;
                }
                patch.workspace = body.workspace.trim();
            }

            if ('password' in body) {
                if (typeof body.password !== 'string') {
                    res.status(400).json({ error: 'password must be a string' });
                    return;
                }
                // Empty string = clear password
                patch.password = body.password;
            }

            saveConfig(CONFIG_PATH, patch);
            // Hot-reload cfg fields so subsequent requests reflect the change
            if (patch.workspace) cfg.workspace = patch.workspace;
            if ('password' in patch) cfg.password = patch.password!;

            res.json({ ok: true });
        } catch (err: any) {
            res.status(500).json({ error: err?.message ?? 'Failed to save config' });
        }
    });

    // /api/nvim-ready — always returns HTTP 200, even on unexpected errors
    app.get('/api/nvim-ready', async (_req, res) => {
        try {
            const sockPath = ptyManager.getPrimarySocketPath();
            if (!sockPath) {
                res.status(200).json({ ready: false });
                return;
            }
            const ready = await checkNvimReady(sockPath);
            res.status(200).json({ ready });
        } catch {
            res.status(200).json({ ready: false });
        }
    });

    // /api/metrics — returns app RSS memory and total system RAM
    app.get('/api/metrics', (_req, res) => {
        const appMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const totalGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
        res.json({ appMB, totalGB });
    });

    // /api/nvim-open?file=<abs-path>[&instanceId=<id>]
    // Sends a file to the running Neovim instance via its RPC socket.
    // Retries for up to 10s to handle the startup race where nvim is still
    // initialising when the first file-open request arrives.
    app.get('/api/nvim-open', async (req, res) => {
        const file = req.query['file'];
        if (typeof file !== 'string' || !file) {
            res.status(400).json({ error: 'Missing file param' });
            return;
        }
        // Safety: only allow absolute paths without traversal
        if (!file.startsWith('/') || file.includes('..')) {
            res.status(400).json({ error: 'Invalid path' });
            return;
        }
        const instanceId = typeof req.query['instanceId'] === 'string' ? req.query['instanceId'] : undefined;
        const RETRY_MS = 500;
        const MAX_ATTEMPTS = 20; // up to 10 seconds
        let lastErr: any;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            const sockPath = instanceId
                ? ptyManager.getSocketPath(instanceId)
                : ptyManager.getPrimarySocketPath();
            if (!sockPath) {
                if (i < MAX_ATTEMPTS - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
                }
                continue;
            }
            // Wait until nvim's RPC socket is actually accepting connections
            const ready = await checkNvimReady(sockPath, 400);
            if (!ready) {
                if (i < MAX_ATTEMPTS - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
                }
                continue;
            }
            try {
                await execFileAsync(cfg.nvim.bin, ['--server', sockPath, '--remote-silent', file], {
                    timeout: 3000,
                });
                // Change nvim's cwd to the opened file's directory
                const fileDir = path.dirname(file);
                await execFileAsync(cfg.nvim.bin, ['--server', sockPath, '--remote-send', `:cd ${fileDir}\r`], {
                    timeout: 1000,
                }).catch(() => { /* best-effort — don't fail the open */ });
                res.json({ ok: true });
                return;
            } catch (err: any) {
                lastErr = err;
                if (i < MAX_ATTEMPTS - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
                }
            }
        }
        res.status(503).json({ error: 'Neovim not running after 10s', detail: lastErr?.message });
    });

    // /api/nvim-config — GET returns current nvim settings; POST saves them
    app.get('/api/nvim-config', (_req, res) => {
        res.json(ptyManager.getNvimConfigInfo());
    });

    app.post('/api/nvim-config', express.json(), (req, res) => {
        try {
            const body = req.body as Record<string, unknown>;
            const patch: Record<string, unknown> = {};

            if ('bin' in body) {
                if (typeof body.bin !== 'string' || !body.bin) {
                    res.status(400).json({ error: 'bin must be a non-empty string' });
                    return;
                }
                patch.bin = body.bin;
            }

            if ('configMode' in body) {
                const m = body.configMode;
                if (m !== 'system' && m !== 'bundled' && m !== 'custom') {
                    res.status(400).json({ error: 'configMode must be system|bundled|custom' });
                    return;
                }
                patch.configMode = m;
            }

            if ('configDir' in body) {
                if (typeof body.configDir !== 'string') {
                    res.status(400).json({ error: 'configDir must be a string' });
                    return;
                }
                patch.configDir = body.configDir;
            }

            saveNvimConfig(CONFIG_PATH, patch as any);
            ptyManager.reloadConfig();
            res.json({ ok: true, config: ptyManager.getNvimConfigInfo() });
        } catch (err: any) {
            res.status(500).json({ error: err?.message ?? 'Failed to save config' });
        }
    });

    // /api/nvim-config-dir — returns the resolved absolute path of the currently
    // active nvim config directory, based on the configured configMode.
    app.get('/api/nvim-config-dir', (_req, res) => {
        const info = ptyManager.getNvimConfigInfo();
        let configDir: string;
        if (info.configMode === 'bundled') {
            configDir = info.bundledConfigDir;
        } else if (info.configMode === 'custom' && info.configDir) {
            configDir = info.configDir;
        } else {
            // system (default): ~/.config/nvim
            configDir = path.join(os.homedir(), '.config', 'nvim');
        }
        res.json({ configDir });
    });
}

/**
 * Validate startup preconditions and exit fatally if they fail.
 * Call this before starting the HTTP server.
 */
export function validateStartup(cfg: MineoCfg): void {
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(cfg.workspace)) {
        process.stderr.write(
            `Error: Workspace not found: "${cfg.workspace}". Create it or update workspace in config.json.\n`
        );
        process.exit(1);
    }

    try {
        execSync(`"${cfg.nvim.bin}" --version`, { stdio: 'ignore' });
    } catch {
        process.stderr.write(
            `Error: nvim not found at "${cfg.nvim.bin}". Install Neovim or fix nvim.bin in config.json.\n`
        );
        process.exit(1);
    }
}
