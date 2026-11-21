'use strict';

/**
 * SkyMP runs the gamemode entry file from a copy in a temp folder, so a
 * `require('./…')` there resolves against the temp folder and fails at boot
 * ("Cannot find module './core/position-persistence'"; position saving never
 * started because of it). The entry file must build paths from gamemodeDir.
 * Modules it loads are normal files and may use './' freely.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');

it('phase0-basic.js has no relative require', () => {
  const src = fs.readFileSync(path.join(__dirname, 'phase0-basic.js'), 'utf8');
  const hits = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && /require\(\s*['"`]\.\.?\//.test(line));
  assert.deepEqual(hits, [], `use path.join(gamemodeDir, …) instead:\n${hits.map((h) => `  line ${h.n}: ${h.line}`).join('\n')}`);
});
