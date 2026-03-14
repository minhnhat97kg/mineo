#!/usr/bin/env node
/**
 * apply-patches.js — applies patches/ to node_modules after npm install.
 *
 * Each patch is a .js file exporting { target, find, replace, guard? }.
 * Run automatically via "postinstall" in package.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(ROOT, 'patches');

if (!fs.existsSync(PATCHES_DIR)) {
  process.exit(0);
}

const patches = fs.readdirSync(PATCHES_DIR)
  .filter(f => f.endsWith('.js'))
  .sort();

if (patches.length === 0) {
  process.exit(0);
}

let applied = 0;
let skipped = 0;
let failed = 0;

for (const patchFile of patches) {
  const patchPath = path.join(PATCHES_DIR, patchFile);

  let patch;
  try {
    patch = require(patchPath);
  } catch (err) {
    console.error(`[patches] Cannot load ${patchFile}: ${err.message}`);
    failed++;
    continue;
  }

  const targetPath = path.join(ROOT, patch.target);

  if (!fs.existsSync(targetPath)) {
    console.warn(`[patches] Skipping ${patchFile}: target not found (${patch.target})`);
    skipped++;
    continue;
  }

  let content = fs.readFileSync(targetPath, 'utf8');

  // If replace string already present → already applied
  if (content.includes(patch.replace)) {
    console.log(`[patches] Already applied: ${patchFile}`);
    skipped++;
    continue;
  }

  // If find string not present → can't apply (file changed unexpectedly)
  if (!content.includes(patch.find)) {
    console.warn(`[patches] Cannot apply ${patchFile}: find string not found in ${patch.target}`);
    skipped++;
    continue;
  }

  content = content.replace(patch.find, patch.replace);
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log(`[patches] Applied: ${patchFile}`);
  applied++;
}

console.log(`[patches] Done: ${applied} applied, ${skipped} skipped, ${failed} failed`);
if (failed > 0) process.exit(1);
