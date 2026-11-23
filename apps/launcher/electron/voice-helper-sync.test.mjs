import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncVoiceHelper } from './voice-helper.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sync-'));
}

test('copies the exe when the target does not exist', () => {
  const dir = tmp();
  const source = path.join(dir, 'voice-helper.exe');
  const target = path.join(dir, 'game', 'Data', 'Platform', 'voice-helper.exe');
  fs.writeFileSync(source, 'BINARIO-V1');

  const r = syncVoiceHelper({ sourcePath: source, targetPath: target });
  assert.deepEqual(r, { ok: true, repaired: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'BINARIO-V1');
});

test('does not rewrite when the hash matches', () => {
  const dir = tmp();
  const source = path.join(dir, 'voice-helper.exe');
  const target = path.join(dir, 'voice-helper.exe.copy');
  fs.writeFileSync(source, 'IGUAL');
  fs.writeFileSync(target, 'IGUAL');
  const mtimeBefore = fs.statSync(target).mtimeMs;

  const r = syncVoiceHelper({ sourcePath: source, targetPath: target });
  assert.deepEqual(r, { ok: true, repaired: false });
  assert.equal(fs.statSync(target).mtimeMs, mtimeBefore, 'must not have touched the file');
});

test('repairs when the target differs', () => {
  const dir = tmp();
  const source = path.join(dir, 'voice-helper.exe');
  const target = path.join(dir, 'target.exe');
  fs.writeFileSync(source, 'NOVO');
  fs.writeFileSync(target, 'VELHO');

  const r = syncVoiceHelper({ sourcePath: source, targetPath: target });
  assert.deepEqual(r, { ok: true, repaired: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'NOVO');
});

test('fail-open when the exe was not packaged: ok:true, skipped', () => {
  const dir = tmp();
  const r = syncVoiceHelper({
    sourcePath: path.join(dir, 'does-not-exist.exe'),
    targetPath: path.join(dir, 'target.exe')
  });
  assert.equal(r.ok, true);
  assert.equal(r.repaired, false);
  assert.equal(r.skipped, true);
  assert.equal(fs.existsSync(path.join(dir, 'target.exe')), false);
});

test('an empty sourcePath does not blow up', () => {
  const r = syncVoiceHelper({ sourcePath: '', targetPath: path.join(tmp(), 'x.exe') });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});
