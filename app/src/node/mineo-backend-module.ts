import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import {
  BackendApplicationContribution,
  BackendApplicationServer,
} from '@theia/core/lib/node/backend-application';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import express = require('@theia/core/shared/express');
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { Application } from 'express';
import { loadConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';
import { checkNvimReady } from './nvim-ready';
import { NeovimPtyContribution } from './neovim-pty-contribution';
import { LspServerManager } from './lsp-server-manager';

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
  configure(app: Application): void {
    // /healthz — always available, no auth required.
    // Registered here (after auth middleware in MineoBASServer.configure())
    // because /healthz is explicitly exempt in the auth guard.
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // /api/nvim-open?file=<abs-path>
    // Sends a file to the running Neovim instance via its RPC socket.
    // Retries for up to 10s to handle the startup race where nvim is still
    // initialising when the first file-open request arrives.
    // Uses execFileAsync (non-blocking) so the event loop stays free during retries.
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
      const NVIM_SOCK = '/tmp/mineo-nvim.sock';
      const RETRY_MS = 500;
      const MAX_ATTEMPTS = 20; // up to 10 seconds
      let lastErr: any;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
          await execFileAsync(cfg.nvim.bin, ['--server', NVIM_SOCK, '--remote-silent', file], {
            timeout: 3000,
          });
          res.json({ ok: true });
          return;
        } catch (err: any) {
          lastErr = err;
          // Only retry if the socket doesn't exist yet (nvim still starting)
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

    // /api/nvim-ready — always returns HTTP 200, even on unexpected errors
    app.get('/api/nvim-ready', async (_req, res) => {
      try {
        const ready = await checkNvimReady();
        res.status(200).json({ ready });
      } catch {
        // Defensive: checkNvimReady should never throw, but guard here to
        // guarantee the spec's "always HTTP 200" contract.
        res.status(200).json({ ready: false });
      }
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
  bind(BackendApplicationContribution).to(MineoBACContribution).inSingletonScope();
  // Binding BackendApplicationServer prevents server.js from binding the default
  // static-only server and lets us control middleware order.
  bind(BackendApplicationServer).to(MineoBASServer).inSingletonScope();
  // Neovim PTY — MessagingService.Contribution that spawns nvim and pipes I/O
  bind(MessagingService.Contribution).to(NeovimPtyContribution).inSingletonScope();
  bind(BackendApplicationContribution).to(LspServerManager).inSingletonScope();
});
