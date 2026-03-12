import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateSecret } from '../../app/src/node/secret';

function tmpPath(): string {
  return path.join(os.tmpdir(), `mineo-test-secret-${Date.now()}`);
}

test('generates a secret and writes it when file missing', () => {
  const p = tmpPath();
  const secret = loadOrCreateSecret(p);
  assert.ok(typeof secret === 'string' && secret.length === 64, 'should be 64-char hex');
  assert.equal(fs.readFileSync(p, 'utf8'), secret);
  fs.unlinkSync(p);
});

test('reads existing secret without overwriting', () => {
  const p = tmpPath();
  fs.writeFileSync(p, 'abcdef1234567890'.repeat(4));
  const secret = loadOrCreateSecret(p);
  assert.equal(secret, 'abcdef1234567890'.repeat(4));
  fs.unlinkSync(p);
});

test('calls process.exit(1) when file cannot be written', (t) => {
  // Skip this test when running as root — root ignores chmod 0o444
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('cannot test read-only FS as root');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineo-ro-'));
  fs.chmodSync(dir, 0o444);
  const p = path.join(dir, '.secret');

  const origExit = process.exit.bind(process);
  let exitCode: number | undefined;
  // @ts-ignore
  process.exit = (code: number) => { exitCode = code; throw new Error('process.exit called'); };

  try {
    loadOrCreateSecret(p);
  } catch {
    // swallow the synthetic throw from our mock
  } finally {
    // @ts-ignore
    process.exit = origExit;
    fs.chmodSync(dir, 0o755);
    fs.rmdirSync(dir);
  }
  assert.equal(exitCode, 1, 'process.exit should be called with code 1');
});
