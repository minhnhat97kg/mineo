import express, { Application, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import http from 'http';
import { parse as parseCookies } from 'cookie';

interface AuthOptions {
  password: string;
  secret: string;
  /** Express app to register middleware on. */
  app: Application;
}

const LOGIN_HTML = (error?: string) => `<!DOCTYPE html>
<html>
<head><title>Mineo Login</title>
<style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #282c34; color: #abb2bf; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input[type=password] { padding: 8px; border-radius: 4px; border: 1px solid #4b5263; background: #1e2127; color: #abb2bf; }
  button { padding: 8px 16px; border-radius: 4px; border: none; background: #61afef; color: #282c34; cursor: pointer; font-weight: bold; }
  .error { color: #e06c75; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h2>Mineo</h2>
    ${error ? `<p class="error">${error}</p>` : ''}
    <input type="password" name="password" placeholder="Password" autofocus />
    <button type="submit">Login</button>
  </form>
</body>
</html>`;

// Module-level store reference so registerAuthWS can access it
let _store: any = null;

/**
 * Register HTTP auth middleware on the Express app.
 * Must be called BEFORE express.static is registered so the auth guard
 * intercepts requests before any static file (including index.html) is served.
 * Does nothing if password is empty.
 * Does NOT register /healthz — that is the backend module's responsibility.
 */
export function registerAuth(opts: AuthOptions): void {
  const { password, secret, app } = opts;

  if (!password) return;

  const MemoryStore = require('memorystore')(session);
  _store = new MemoryStore({ checkPeriod: 86400000 });

  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret,
    store: _store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }) as express.RequestHandler);

  // Login GET — serve login form
  app.get('/login', (_req: Request, res: Response) => {
    res.send(LOGIN_HTML());
  });

  // Login POST — handle form submission
  app.post('/login', (req: Request, res: Response) => {
    if (req.body?.password === password) {
      req.session.regenerate((err) => {
        if (err) {
          res.status(500).send('Session error');
          return;
        }
        (req.session as any).authenticated = true;
        res.redirect('/');
      });
    } else {
      res.send(LOGIN_HTML('Incorrect password'));
    }
  });

  // Auth guard — redirect to /login if not authenticated
  // /healthz and /login are always exempt.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/healthz') return next();
    if (req.path === '/login') return next();
    if ((req.session as any)?.authenticated) return next();
    res.redirect('/login');
  });
}

/**
 * Register WebSocket upgrade interceptor.
 * Must be called from onStart() to intercept Theia's WS upgrades.
 * On valid session: re-emits the upgrade event for Theia's handlers.
 * On invalid session: responds 401 and destroys socket.
 * No-op if password is empty.
 */
export function registerAuthWS(opts: { password: string; server: http.Server }): void {
  if (!opts.password || !_store) return;

  const store = _store;
  const originalListeners = opts.server.listeners('upgrade').slice();
  opts.server.removeAllListeners('upgrade');

  opts.server.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const cookieHeader = req.headers['cookie'] ?? '';
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies['connect.sid'];

    if (!sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const rawId = decodeURIComponent(sessionId).replace(/^s:/, '').split('.')[0];
    store.get(rawId, (err: Error | null, sessionData: any) => {
      if (err || !sessionData?.authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Valid session: call original Theia upgrade handlers
      for (const listener of originalListeners) {
        (listener as Function)(req, socket, head);
      }
    });
  });
}
