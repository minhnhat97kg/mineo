import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, DEFAULTS } from '../../app/src/node/config';

function writeTmpConfig(obj: object): string {
  const p = path.join(os.tmpdir(), `mineo-cfg-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('returns all defaults when file is missing', () => {
  const cfg = loadConfig('/nonexistent/path/config.json');
  assert.deepEqual(cfg, DEFAULTS);
});

test('loads valid config', () => {
  const p = writeTmpConfig({ port: 4000, workspace: '/tmp', password: 'x', nvim: { bin: '/usr/bin/nvim' } });
  const cfg = loadConfig(p);
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.workspace, '/tmp');
  assert.equal(cfg.password, 'x');
  assert.equal(cfg.nvim.bin, '/usr/bin/nvim');
});

test('expands tilde in workspace', () => {
  const p = writeTmpConfig({ workspace: '~/mydir' });
  const cfg = loadConfig(p);
  assert.equal(cfg.workspace, path.join(os.homedir(), 'mydir'));
});

test('expands tilde in nvim.bin', () => {
  const p = writeTmpConfig({ nvim: { bin: '~/bin/nvim' } });
  const cfg = loadConfig(p);
  assert.equal(cfg.nvim.bin, path.join(os.homedir(), 'bin/nvim'));
});

test('uses default and warns for wrong type: port', (_t) => {
  const p = writeTmpConfig({ port: 'notanumber' });
  const stderrMsgs: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // @ts-ignore
  process.stderr.write = (s: string) => { stderrMsgs.push(s); return true; };
  const cfg = loadConfig(p);
  // @ts-ignore
  process.stderr.write = origWrite;
  assert.equal(cfg.port, DEFAULTS.port);
  assert.ok(stderrMsgs.some(m => m.includes('[config] port must be a number')));
});

test('silently ignores unknown keys', () => {
  const p = writeTmpConfig({ unknown: true, port: 5000 });
  const cfg = loadConfig(p);
  assert.equal(cfg.port, 5000);
  assert.equal((cfg as any).unknown, undefined);
});
