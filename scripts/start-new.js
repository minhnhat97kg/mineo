#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'server.js');

execFileSync(process.execPath, [SERVER_ENTRY], { stdio: 'inherit' });
