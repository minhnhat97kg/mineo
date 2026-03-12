import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'http';
import express from 'express';
import { registerAuth } from '../../app/src/node/auth';

// Helper: make a test request against an express app
function req(app: express.Application, reqPath: string, opts: {
  method?: string; body?: string; cookie?: string
} = {}): Promise<{ status: number; body: string; headers: http.IncomingMessage['headers'] }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(opts.body) } : {}),
        },
      };
      const r = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      });
      if (opts.body) r.write(opts.body);
      r.end();
    });
  });
}

test('when password is empty, registerAuth is a no-op — requests pass through', async () => {
  const app = express();
  registerAuth({ password: '', secret: 'testsecret', app });
  app.get('/test', (_req, res) => res.send('ok'));
  const result = await req(app, '/test');
  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
});

test('when password set, unauthenticated request redirects to /login', async () => {
  const app = express();
  registerAuth({ password: 'secret123', secret: 'testsecret', app });
  app.get('/protected', (_req, res) => res.send('private'));
  const result = await req(app, '/protected');
  assert.equal(result.status, 302);
  assert.ok(result.headers.location?.includes('/login'));
});

test('/login GET returns HTML with password field', async () => {
  const app = express();
  registerAuth({ password: 'secret123', secret: 'testsecret', app });
  const result = await req(app, '/login');
  assert.equal(result.status, 200);
  assert.ok(result.body.includes('<input'));
  assert.ok(result.body.includes('password'));
});

test('/login POST with wrong password re-renders with error', async () => {
  const app = express();
  registerAuth({ password: 'correct', secret: 'testsecret', app });
  const result = await req(app, '/login', { method: 'POST', body: 'password=wrong' });
  assert.equal(result.status, 200);
  assert.ok(result.body.includes('Incorrect password'));
});

test('/login POST with correct password redirects to /', async () => {
  const app = express();
  registerAuth({ password: 'correct', secret: 'testsecret', app });
  const result = await req(app, '/login', { method: 'POST', body: 'password=correct' });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, '/');
});
