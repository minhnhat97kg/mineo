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
  const server = net.createServer((socket) => {
    // Send a byte immediately to indicate socket is responsive
    socket.write('\0');
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  try {
    const result = await checkNvimReady(sockPath);
    assert.strictEqual(result, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('checkNvimReady returns false when connection hangs (timeout path)', async () => {
  const sockPath = '/tmp/mineo-test-hang-' + Date.now() + '.sock';
  // Server accepts connections but never sends data — forces the 'timeout' event
  const server = net.createServer((_socket) => { /* hold open, never respond */ }).listen(sockPath);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  try {
    // 1ms timeout — socket accepted but inactivity timeout triggers before 'connect' resolves
    const result = await checkNvimReady(sockPath, 1);
    assert.strictEqual(result, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
