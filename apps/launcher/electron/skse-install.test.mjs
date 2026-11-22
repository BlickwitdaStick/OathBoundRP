import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKSE, SKYRIM_1170_SHA256, checkSkse, downloadSkse } from './skse-install.mjs';

function gameDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skse-'));
  fs.mkdirSync(path.join(dir, 'Data', 'Scripts'), { recursive: true });
  return dir;
}

test('SKSE comes only from the official site', () => {
  assert.match(SKSE.url, /^https:\/\/skse\.silverlock\.org\//);
  assert.equal(SKSE.archiveSha256.length, 64);
});

test('check: missing everything, then installed, and the Skyrim build', async () => {
  const dir = gameDir();
  const fakeHash = async (file) => {
    const name = path.basename(file);
    if (name === 'SkyrimSE.exe') return fs.readFileSync(file, 'utf8');
    return SKSE.rootFiles[name] && fs.readFileSync(file, 'utf8') === 'ok' ? SKSE.rootFiles[name] : 'other';
  };
  let r = await checkSkse(dir, { hash: fakeHash });
  assert.equal(r.installed, false);
  assert.deepEqual(r.missing, ['skse64_loader.exe', 'skse64_1_6_1170.dll', 'Data/Scripts/skse.pex']);
  assert.equal(r.skyrimVersionOk, null, 'no SkyrimSE.exe: unknown');

  for (const name of Object.keys(SKSE.rootFiles)) fs.writeFileSync(path.join(dir, name), 'ok');
  fs.writeFileSync(path.join(dir, 'Data', 'Scripts', 'skse.pex'), 'x');
  fs.writeFileSync(path.join(dir, 'SkyrimSE.exe'), SKYRIM_1170_SHA256);
  r = await checkSkse(dir, { hash: fakeHash });
  assert.deepEqual(r, { installed: true, missing: [], skyrimVersionOk: true });

  fs.writeFileSync(path.join(dir, 'SkyrimSE.exe'), 'some other build');
  assert.equal((await checkSkse(dir, { hash: fakeHash })).skyrimVersionOk, false);
});

test('a download that is not the official archive is refused and not kept', async () => {
  const dir = gameDir();
  const dest = path.join(dir, 'skse.7z');
  const fetchImpl = async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from('tampered'); })() });
  await assert.rejects(downloadSkse({ dest, fetchImpl }), /did not match/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});
