import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const homeSource = fs.readFileSync(path.join(here, '..', 'src', 'pages', 'Home.tsx'), 'utf8');
const playHandler = homeSource.match(/const handlePlay = async \(\) => \{([\s\S]*?)\n  \};/);

test('the PLAY flow validates the version before consuming a queue ticket', () => {
  assert.ok(playHandler, 'handlePlay not found');
  const source = playHandler[1];
  const versionCheck = source.indexOf('checkClientUpdate(gamePath)');
  const modCheck = source.indexOf('verifyMods(gamePath)');
  const queueJoin = source.indexOf('joinQueue()');

  assert.ok(versionCheck >= 0, 'version gate missing');
  assert.ok(versionCheck < modCheck, 'the version must be validated before mod parity');
  assert.ok(versionCheck < queueJoin, 'the version must be validated before consuming the queue ticket');
});

test('the gate fails closed when the manifest is unavailable or there is an update', () => {
  assert.ok(playHandler, 'handlePlay not found');
  assert.match(playHandler[1], /if \(clientUpdate\.error\) \{[\s\S]*?return;/);
  assert.match(playHandler[1], /if \(clientUpdate\.updateAvailable\) \{[\s\S]*?return;/);
});

test('the PLAY flow installs or repairs the UI before the queue and fails closed', () => {
  assert.ok(playHandler, 'handlePlay not found');
  const source = playHandler[1];
  const uiCheck = source.indexOf('ensureSkympUi(gamePath)');
  const queueJoin = source.indexOf('joinQueue()');

  assert.ok(uiCheck >= 0, 'UI install/repair missing');
  assert.ok(uiCheck < queueJoin, 'the UI must be ensured before consuming the queue ticket');
  assert.match(source, /if \(!ui\.ok\) \{[\s\S]*?return;/);
});
