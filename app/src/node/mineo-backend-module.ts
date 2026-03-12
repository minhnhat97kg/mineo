import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { injectable } from '@theia/core/shared/inversify';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { Application } from 'express';
import { loadConfig } from './config';
import { loadOrCreateSecret } from './secret';
import { registerAuth, registerAuthWS } from './auth';

const CONFIG_PATH = path.resolve(__dirname, '../../../config.json');
const SECRET_PATH = path.resolve(__dirname, '../../../.secret');
const VSIX_PATH = path.resolve(__dirname, '../../../plugins/vscode-neovim.vsix');

@injectable()
class MineoBACContribution implements BackendApplicationContribution {
  private cfg = loadConfig(CONFIG_PATH);
  private secret = '';

  configure(app: Application): void {
    // Validate workspace
    if (!fs.existsSync(this.cfg.workspace)) {
      process.stderr.write(
        `Error: Workspace not found: "${this.cfg.workspace}". Create it or update workspace in config.json.\n`
      );
      process.exit(1);
    }

    // Validate nvim binary
    try {
      require('child_process').execSync(`"${this.cfg.nvim.bin}" --version`, { stdio: 'ignore' });
    } catch {
      process.stderr.write(
        `Error: nvim not found at "${this.cfg.nvim.bin}". Install Neovim or fix nvim.bin in config.json.\n`
      );
      process.exit(1);
    }

    // Warn if vsix missing (non-fatal — plugin host will fail gracefully)
    if (!fs.existsSync(VSIX_PATH)) {
      process.stderr.write(
        '[mineo] vscode-neovim plugin not found. Run: npm run download-plugins\n'
      );
    }

    this.secret = loadOrCreateSecret(SECRET_PATH);

    // Register /healthz — always available, no auth required
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Register HTTP auth middleware (no-op if password is empty)
    registerAuth({ password: this.cfg.password, secret: this.secret, app });
  }

  onStart(server: http.Server): void {
    // Register WS auth interceptor (no-op if password is empty)
    registerAuthWS({ password: this.cfg.password, server });

    console.log(`Mineo ready on http://localhost:${this.cfg.port}`);
  }
}

export default new ContainerModule((bind) => {
  bind(BackendApplicationContribution).to(MineoBACContribution).inSingletonScope();
});
