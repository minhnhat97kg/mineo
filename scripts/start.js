#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Allow tests to pass a custom config path via MINEO_CONFIG env var
// to avoid overwriting the developer's real config.json.
const CONFIG_PATH = process.env.MINEO_CONFIG || path.join(ROOT, 'config.json');
const APP_DIR = path.join(ROOT, 'app');

function expandTilde(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

let cfg = { port: 3000, workspace: path.join(os.homedir(), 'projects') };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (typeof raw.port === 'number') cfg.port = raw.port;
    if (typeof raw.workspace === 'string') cfg.workspace = expandTilde(raw.workspace);
  } catch (e) {
    // ignore — backend module will warn
  }
}

const workspace = cfg.workspace;
const port = String(cfg.port);
// Use relative path ../plugins — resolved from APP_DIR (app/), consistent with spec.
// This means theia start resolves plugins relative to the app/ working directory.
const pluginsFlag = 'local-dir:../plugins';

// theia start <workspace> --port <port> --plugins local-dir:../plugins
// npm workspaces may hoist the theia binary to the root node_modules — fall back to root if not found in app/
const theiaInApp = path.join(APP_DIR, 'node_modules', '.bin', 'theia');
const theiaInRoot = path.join(ROOT, 'node_modules', '.bin', 'theia');
const theia = fs.existsSync(theiaInApp) ? theiaInApp : theiaInRoot;

process.chdir(APP_DIR);
execFileSync(theia, ['start', workspace, '--port', port, '--plugins', pluginsFlag], {
  stdio: 'inherit',
  cwd: APP_DIR,
});
