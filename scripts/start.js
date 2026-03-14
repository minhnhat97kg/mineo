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

// Seed ~/.theia/recentworkspace.json with cfg.workspace on first run only (empty list).
// After "Open Folder", Theia writes the chosen folder as the first entry — we never
// override that. Without this seed, a fresh install would open with no workspace.
const recentWorkspacePath = path.join(os.homedir(), '.theia', 'recentworkspace.json');
try {
  let recentRoots = [];
  if (fs.existsSync(recentWorkspacePath)) {
    const existing = JSON.parse(fs.readFileSync(recentWorkspacePath, 'utf8'));
    if (Array.isArray(existing.recentRoots)) recentRoots = existing.recentRoots;
  }
  if (recentRoots.length === 0) {
    fs.mkdirSync(path.dirname(recentWorkspacePath), { recursive: true });
    fs.writeFileSync(recentWorkspacePath, JSON.stringify({
      recentRoots: ['file://' + workspace]
    }));
  }
} catch (e) {
  // Non-fatal — Theia will open without a workspace
}

// npm workspaces may hoist the theia binary to the root node_modules — fall back to root if not found in app/
const theiaInApp = path.join(APP_DIR, 'node_modules', '.bin', 'theia');
const theiaInRoot = path.join(ROOT, 'node_modules', '.bin', 'theia');
const theia = fs.existsSync(theiaInApp) ? theiaInApp : theiaInRoot;

// Do NOT pass workspace as a positional arg — that would override "Open Folder" selections.
// Instead we seed recentworkspace.json above so first-run opens cfg.workspace.
process.chdir(APP_DIR);
execFileSync(theia, ['start', '--port', port, '--hostname', '0.0.0.0', '--plugins', pluginsFlag], {
  stdio: 'inherit',
  cwd: APP_DIR,
});
