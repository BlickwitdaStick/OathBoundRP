import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncUiBundle } from './ui-integrity.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skymp-ui-test-'));
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'index.html'), '<script src="panel.js"></script>');
  fs.writeFileSync(path.join(sourceDir, 'panel.js'), 'window.ready = true;');
  return { root, sourceDir, targetDir };
}

test('installs a missing UI', (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));

  const result = syncUiBundle(dirs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repaired, ['index.html', 'panel.js']);
  assert.equal(fs.readFileSync(path.join(dirs.targetDir, 'panel.js'), 'utf8'), 'window.ready = true;');
});

test('repairs a differing file and keeps an extra file', (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  fs.mkdirSync(dirs.targetDir);
  fs.writeFileSync(path.join(dirs.targetDir, 'index.html'), 'corrompido');
  fs.writeFileSync(path.join(dirs.targetDir, 'extra.txt'), 'preservar');

  const result = syncUiBundle(dirs);
  assert.equal(result.ok, true);
  assert.ok(result.repaired.includes('index.html'));
  assert.equal(fs.readFileSync(path.join(dirs.targetDir, 'extra.txt'), 'utf8'), 'preservar');
});

test('does not rewrite files that already match', (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  syncUiBundle(dirs);

  const result = syncUiBundle(dirs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repaired, []);
  assert.equal(result.files, 2);
});

test('fails closed when the internal bundle has no index.html', (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(dirs.sourceDir, 'index.html'));

  const result = syncUiBundle(dirs);
  assert.equal(result.ok, false);
  assert.match(result.error, /index\.html/);
});
