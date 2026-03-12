import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';

// Find a free port
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// Poll /healthz until 200 or timeout
function waitForHealthz(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`/healthz not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(poll, 100);
        }
        res.resume();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`/healthz not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(poll, 100);
        }
      });
    }
    poll();
  });
}

let server: ChildProcess;
let port: number;
let workspaceDir: string;
let configPath: string;

test.beforeAll(async () => {
  port = await getFreePort();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineo-test-'));
  configPath = path.join(os.tmpdir(), `mineo-test-config-${Date.now()}.json`);

  fs.writeFileSync(configPath, JSON.stringify({
    port,
    workspace: workspaceDir,
    password: 'test',
    nvim: { bin: 'nvim' },
  }));

  const projectRoot = path.resolve(__dirname, '..');
  // Pass config via MINEO_CONFIG env var — avoids overwriting the developer's config.json
  server = spawn('node', ['scripts/start.js'], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: { ...process.env, MINEO_CONFIG: configPath },
  });

  server.stderr?.on('data', (d) => process.stderr.write(d));
  server.stdout?.on('data', (d) => process.stdout.write(d));

  await waitForHealthz(port, 90_000);
});

test.afterAll(async () => {
  server?.kill();
  try { fs.unlinkSync(configPath); } catch {}
  try { fs.rmSync(workspaceDir, { recursive: true }); } catch {}
});

test('full smoke test: login → editor → mode indicator → file tree', async ({ page }) => {
  // 1. Navigate to app
  await page.goto(`http://127.0.0.1:${port}`);

  // 2. Assert login page
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 5000 });

  // 3. Submit password
  await passwordInput.fill('test');
  await passwordInput.press('Enter');

  // 4. Assert Monaco editor present
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });

  // 5. Click Monaco editor to ensure focus, then press 'i' for INSERT mode
  await page.locator('.monaco-editor .inputarea').click();
  await page.keyboard.press('i');

  // 6. Wait for INSERT mode indicator
  await page.waitForFunction(
    () => document.querySelector('#vscode-neovim-status')?.textContent?.includes('INSERT'),
    { timeout: 5000 }
  );

  // 7. Press Escape for NORMAL mode
  await page.keyboard.press('Escape');

  // 8. Wait for NORMAL mode (INSERT + VISUAL absent)
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#vscode-neovim-status')?.textContent ?? '';
      return !t.includes('INSERT') && !t.includes('VISUAL');
    },
    { timeout: 5000 }
  );

  // 9. Blur editor first so vscode-neovim doesn't intercept Ctrl+B
  // (in NORMAL mode, Ctrl+B is vim page-backward — we need Theia's keybinding)
  await page.locator('body').click({ position: { x: 0, y: 0 } });
  await page.keyboard.press('Control+b');

  // 10. Assert navigator/file-tree widget visible
  await expect(page.locator('.theia-navigator-container, #navigator-view-container')).toBeVisible({ timeout: 5000 });
});
