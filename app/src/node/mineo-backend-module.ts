import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import {
  BackendApplicationContribution,
  BackendApplicationServer,
} from '@theia/core/lib/node/backend-application';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import express = require('@theia/core/shared/express');
import { execSync } from 'child_process';
import { Application } from 'express';
import { loadConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';

// __dirname at @theia/cli runtime: <root>/app/lib/node/
// Three levels up: <root>/
// MINEO_CONFIG env var overrides config path (used by the smoke test to avoid
// overwriting the developer's real config.json).
const CONFIG_PATH = process.env.MINEO_CONFIG || path.resolve(__dirname, '../../../config.json');
const SECRET_PATH = path.resolve(__dirname, '../../../.secret');
const VSIX_PATH = path.resolve(__dirname, '../../../plugins/vscode-neovim.vsix');
// Static frontend files are in app/lib/frontend after `theia build`
const FRONTEND_DIR = path.resolve(__dirname, '../../lib/frontend');

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

// Warn if vsix missing (non-fatal — plugin host will fail gracefully)
if (!fs.existsSync(VSIX_PATH)) {
  process.stderr.write(
    '[mineo] vscode-neovim plugin not found. Run: npm run download-plugins\n'
  );
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
});
