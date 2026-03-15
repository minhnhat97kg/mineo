import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import {
  BackendApplicationContribution,
  BackendApplicationServer,
} from '@theia/core/lib/node/backend-application';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import express = require('@theia/core/shared/express');
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { Application } from 'express';
import { loadConfig, saveNvimConfig, saveConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';
import { checkNvimReady } from './nvim-ready';
import { NeovimPtyContribution } from './neovim-pty-contribution';
import { LspServerManager } from './lsp-server-manager';
import { PtyManager } from './pty-manager';

// __dirname at @theia/cli runtime: <root>/app/lib/node/
// Three levels up: <root>/
// MINEO_CONFIG env var overrides config path (used by the smoke test to avoid
// overwriting the developer's real config.json).
const CONFIG_PATH = process.env.MINEO_CONFIG || path.resolve(__dirname, '../../../config.json');
const SECRET_PATH = path.resolve(__dirname, '../../../.secret');
const FRONTEND_DIR = path.resolve(__dirname, '../../lib/frontend');

// Increase disconnected buffer size to 50MB (default is 100KB)
// to prevent "Max disconnected buffer size exceeded" errors when backgrounded
(SocketWriteBuffer as any).DISCONNECTED_BUFFER_SIZE = 50 * 1024 * 1024;

// Load config and secret at module-load time (before any configure() calls).
// This ensures both are available when MineoBASServer.configure() runs.
// Fatal errors (workspace missing, nvim missing, .secret unwritable) exit here.
const cfg = loadConfig(CONFIG_PATH);

// Validate workspace
if (!fs.existsSync(cfg.workspace)) {
  process.stderr.write(
    `Error: Workspace not found: "${cfg.workspace}". Create it or update workspace in config.json.\n`
  );
  process.exit(1);
}

// Validate nvim binary
try {
  execSync(`"${cfg.nvim.bin}" --version`, { stdio: 'ignore' });
} catch {
  process.stderr.write(
    `Error: nvim not found at "${cfg.nvim.bin}". Install Neovim or fix nvim.bin in config.json.\n`
  );
  process.exit(1);
}

// secret is loaded here so MineoBASServer.configure() can use it immediately.
// loadOrCreateSecret exits fatally if .secret is unwritable.
const secret = loadOrCreateSecret(SECRET_PATH);

/**
 * MineoBACContribution — registers /healthz and the WS auth interceptor + ready log.
 * Validation and secret loading happen at module-load time (above) so they
 * run eagerly and are available to both contributions without ordering issues.
 */
@injectable()
class MineoBACContribution implements BackendApplicationContribution {
  @inject(PtyManager) private readonly ptyManager!: PtyManager;

  configure(app: Application): void {
    // /healthz — always available, no auth required.
    // Registered here (after auth middleware in MineoBASServer.configure())
    // because /healthz is explicitly exempt in the auth guard.
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // /api/nvim-open?file=<abs-path>
    // Sends a file to the running Neovim instance via its RPC socket.
    // Uses PtyManager to get the primary editor's socket path.
    // Retries for up to 10s to handle the startup race where nvim is still
    // initialising when the first file-open request arrives.
    app.get('/api/nvim-open', async (req, res) => {
      const file = req.query['file'];
      if (typeof file !== 'string' || !file) {
        res.status(400).json({ error: 'Missing file param' });
        return;
      }
      // Safety: only allow absolute paths within the configured workspace
      if (!file.startsWith('/') || file.includes('..')) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }
      const instanceId = typeof req.query['instanceId'] === 'string' ? req.query['instanceId'] : undefined;
      const RETRY_MS = 500;
      const MAX_ATTEMPTS = 20; // up to 10 seconds
      let lastErr: any;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // If instanceId specified, target that specific nvim instance; otherwise use primary
        const sockPath = instanceId
            ? this.ptyManager.getSocketPath(instanceId)
            : this.ptyManager.getPrimarySocketPath();
        if (!sockPath) {
          // No editor PTY yet — wait
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

    // /api/workspace — returns the configured workspace root path
    // Used by the frontend to build file:// URIs for LSP initialization.
    app.get('/api/workspace', (_req, res) => {
      res.json({ workspace: cfg.workspace });
    });

    // /api/config — GET returns full user-editable config snapshot
    // POST saves workspace / password fields and hot-reloads cfg.
    app.get('/api/config', (_req, res) => {
      res.json({
        workspace: cfg.workspace,
        password: cfg.password ? '••••••••' : '',
        hasPassword: !!cfg.password,
      });
    });

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
    // Uses PtyManager to get the primary socket path for readiness check.
    app.get('/api/nvim-ready', async (_req, res) => {
      try {
        const sockPath = this.ptyManager.getPrimarySocketPath();
        if (!sockPath) {
          res.status(200).json({ ready: false });
          return;
        }
        const ready = await checkNvimReady(sockPath);
        res.status(200).json({ ready });
      } catch {
        // Defensive: checkNvimReady should never throw, but guard here to
        // guarantee the spec's "always HTTP 200" contract.
        res.status(200).json({ ready: false });
      }
    });

    // /api/metrics — returns app RSS memory and total system RAM
    app.get('/api/metrics', (_req, res) => {
      const appMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const totalGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      res.json({ appMB, totalGB });
    });

    // /api/nvim-config — GET returns current nvim settings; POST saves them
    app.get('/api/nvim-config', (_req, res) => {
      res.json(this.ptyManager.getNvimConfigInfo());
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
        this.ptyManager.reloadConfig();
        res.json({ ok: true, config: this.ptyManager.getNvimConfigInfo() });
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to save config' });
      }
    });

    // /api/nvim-config-dir — returns the resolved absolute path of the currently
    // active nvim config directory, based on the configured configMode:
    //   system  → ~/.config/nvim
    //   bundled → <app>/nvim-config
    //   custom  → cfg.nvim.configDir
    // Used by the frontend "Open config folder" button to add the directory to
    // the workspace so the user can edit their config in the file explorer.
    app.get('/api/nvim-config-dir', (_req, res) => {
      const info = this.ptyManager.getNvimConfigInfo();
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

  onStart(server: http.Server): void {
    // WS auth interceptor — no-op if password is empty
    registerAuthWS({ password: cfg.password, server });

    console.log(`Mineo ready on http://localhost:${cfg.port}`);
  }
}

/**
 * MineoBASServer replaces the default BackendApplicationServer.
 *
 * Theia's server.js does:
 *   if (!container.isBound(BackendApplicationServer)) {
 *     container.bind(BackendApplicationServer).toConstantValue({ configure: defaultServeStatic });
 *   }
 *
 * By binding BackendApplicationServer in our ContainerModule (loaded before start()),
 * we prevent the default static-only server and instead register:
 *   1. Auth middleware (session, login routes, guard) — only if password is set
 *   2. express.static(frontend dir)
 *
 * This ensures unauthenticated requests are redirected to /login BEFORE any
 * static file (including index.html) is served. No circular DI required.
 */
@injectable()
class MineoBASServer implements BackendApplicationServer {
  configure(app: Application): void {
    // Auth middleware must come before static file serving.
    // registerAuth is a no-op if password is empty.
    registerAuth({ password: cfg.password, secret, app });

    // Static file serving — after auth guard
    app.use(express.static(FRONTEND_DIR));
  }
}

export default new ContainerModule((bind) => {
  // PtyManager — singleton that manages all PTY instances
  bind(PtyManager).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).to(MineoBACContribution).inSingletonScope();
  // Binding BackendApplicationServer prevents server.js from binding the default
  // static-only server and lets us control middleware order.
  bind(BackendApplicationServer).to(MineoBASServer).inSingletonScope();
  // Neovim PTY — MessagingService.Contribution that spawns nvim and pipes I/O
  bind(NeovimPtyContribution).toSelf().inSingletonScope();
  bind(MessagingService.Contribution).toService(NeovimPtyContribution);
  // LSP server manager
  bind(BackendApplicationContribution).to(LspServerManager).inSingletonScope();
});
