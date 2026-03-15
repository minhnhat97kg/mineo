import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { loadConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';
import { registerApiRoutes, validateStartup } from './api';
import { attachPtyWebSockets } from './ws-pty';
import { lspServerManager } from './lsp-server-manager';

const CONFIG_PATH = process.env.MINEO_CONFIG || path.join(__dirname, '../../config.json');
const SECRET_PATH = path.join(__dirname, '../../.secret');
const FRONTEND_DIR = path.join(__dirname, '../../client/dist');

async function main(): Promise<void> {
    const cfg = loadConfig(CONFIG_PATH);
    const secret = loadOrCreateSecret(SECRET_PATH);

    // Validate workspace and nvim binary before binding any port
    validateStartup(cfg);

    const app = express();
    const server = http.createServer(app);

    // Auth middleware must come before static file serving.
    // registerAuth is a no-op if password is empty (returns null).
    const store = registerAuth({ password: cfg.password, secret, app });

    registerApiRoutes(app, cfg);

    app.use(express.static(FRONTEND_DIR));
    app.get('*', (_req: express.Request, res: express.Response) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

    // WebSocket handlers — must be attached before the server starts listening
    attachPtyWebSockets(server);
    lspServerManager.attachWebSocket(server);

    // WS auth interceptor wraps all previously registered upgrade listeners.
    // Must be registered AFTER attachPtyWebSockets and lspServerManager so it
    // can capture those listeners and gate them behind session validation.
    if (store) registerAuthWS({ password: cfg.password, server, store });

    server.listen(cfg.port, '0.0.0.0', () => {
        console.log(`Mineo running at http://0.0.0.0:${cfg.port}`);
        console.log(`Workspace: ${cfg.workspace}`);
    });
}

main().catch(err => { console.error(err); process.exit(1); });
