/**
 * core/skymp-adapter/papyrus-usage.test.js
 *
 * Every literal `mp.callPapyrusFunction('method'|'global', 'Class', 'Fn', ...)`
 * in the gamemode must name a function the pinned SkyMP build implements
 * (papyrus-catalog.js). An unknown name does not throw on the server: the VM
 * logs an error and returns null — which is how death-service and the player
 * panel read `Actor.GetActorValue` (nonexistent) for months, until the
 * 19/11/2026 server log showed it every 2 seconds.
 *
 * KNOWN_UNSUPPORTED lists offenders that already existed, all in modules that
 * are OFF in .env. Fixing one should remove it from the list; adding a new
 * unknown call anywhere fails this test.
 *
 * Executa com: node --test core/skymp-adapter/papyrus-usage.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const { isKnownPapyrusFunction, UPSTREAM_COMMIT } = require('./papyrus-catalog');

const GAMEMODE_DIR = path.resolve(__dirname, '..', '..');

const KNOWN_UNSUPPORTED = new Set([
  'corpse-probe.js|method|Actor.getActorValue',  // ENABLE_CORPSE_PROBE (diagnostic)
  'fauna-census.js|method|Actor.getActorValue',  // ENABLE_FAUNA_CENSUS (diagnostic)
  'jobs-service.js|method|Actor.GetItemCount',   // ENABLE_JOBS_SERVICE — catalog has ObjectReference.GetItemCount
  'mining-service.js|method|Actor.GetItemCount'  // ENABLE_MINING_SERVICE — same
]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

function papyrusCalls(file) {
  // Whole-file scan: calls often wrap their arguments onto the next line.
  const calls = [];
  const src = fs.readFileSync(file, 'utf8');
  const re = /callPapyrusFunction\(\s*['"](method|global)['"]\s*,\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lead = src.slice(lineStart, m.index).trim();
    if (lead.startsWith('//') || lead.startsWith('*')) continue; // docs/examples
    calls.push({ line: src.slice(0, m.index).split('\n').length, type: m[1], cls: m[2], fn: m[3] });
  }
  return calls;
}

test(`every literal Papyrus call exists in SkyMP ${UPSTREAM_COMMIT}`, () => {
  const unexpected = [];
  const stillBroken = new Set();
  let total = 0;
  for (const file of sourceFiles(GAMEMODE_DIR)) {
    const rel = path.relative(GAMEMODE_DIR, file).split(path.sep).join('/');
    for (const c of papyrusCalls(file)) {
      total++;
      if (isKnownPapyrusFunction(c.type, c.cls, c.fn)) continue;
      const key = `${rel}|${c.type}|${c.cls}.${c.fn}`;
      if (KNOWN_UNSUPPORTED.has(key)) { stillBroken.add(key); continue; }
      unexpected.push(`${rel}:${c.line} ${c.type} ${c.cls}.${c.fn}`);
    }
  }
  assert.ok(total > 50, `scanner found only ${total} calls — regex broken?`);
  assert.deepStrictEqual(unexpected, [], 'Papyrus functions this SkyMP build does not implement');
  for (const key of KNOWN_UNSUPPORTED) {
    assert.ok(stillBroken.has(key), `${key} was fixed — remove it from KNOWN_UNSUPPORTED`);
  }
});

test('death-service and the player panel no longer read GetActorValue or call Resurrect', () => {
  for (const rel of ['death-service.js', 'player-panel-service.js']) {
    const bad = papyrusCalls(path.join(GAMEMODE_DIR, rel))
      .filter(c => /^(getactorvalue|resurrect)$/i.test(c.fn));
    assert.deepStrictEqual(bad, [], rel);
  }
});
