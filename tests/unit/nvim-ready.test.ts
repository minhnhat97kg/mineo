import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'net';
import { checkNvimReady } from '../../app/src/node/nvim-ready';

test('checkNvimReady returns false when socket does not exist', async () => {
  const result = await checkNvimReady('/tmp/mineo-test-nonexistent-' + Date.now() + '.sock');
  assert.strictEqual(result, false);
});

test('checkNvimReady returns true when socket is listening', async () => {
  const sockPath = '/tmp/mineo-test-' + Date.now() + '.sock';
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  try {
    const result = await checkNvimReady(sockPath);
    assert.strictEqual(result, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('checkNvimReady returns false on timeout', async () => {
  const result = await checkNvimReady('/tmp/mineo-test-timeout-' + Date.now() + '.sock', 50);
  assert.strictEqual(result, false);
});
