import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { downgradeArgs, isValidSteamUsername, backupGameFiles, runDepotDownloader, ensureDepotDownloader, DEPOT_DOWNLOADER } from './skyrim-downgrade.mjs';

test('one DepotDownloader run fetches all three 1.6.1170 depots into the game folder, validating', () => {
  const args = downgradeArgs({ gamePath: 'C:/Games/Skyrim', username: 'some_user1' });
  const after = (flag, n) => args.slice(args.indexOf(flag) + 1, args.indexOf(flag) + 1 + n);
  assert.deepEqual(after('-app', 1), ['489830']);
  assert.deepEqual(after('-depot', 3), ['489831', '489832', '489833']);
  assert.deepEqual(after('-manifest', 3), ['8442952117333549665', '8042843504692938467', '1914580699073641964']);
  assert.deepEqual(after('-dir', 1), ['C:/Games/Skyrim']);
  assert.ok(args.includes('-validate'));
  assert.ok(!args.includes('-password'), 'the password is typed into DepotDownloader, never passed by the launcher');
});

test('Steam account names are checked before anything runs', () => {
  assert.ok(isValidSteamUsername('Blick_2026'));
  for (const bad of ['', 'ab', 'a b', 'x"; del', 'name\n-password']) {
    assert.ok(!isValidSteamUsername(bad), bad);
    assert.throws(() => downgradeArgs({ gamePath: 'x', username: bad }));
  }
});

test('backs up the exe and masters once, never twice', () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
  fs.mkdirSync(path.join(game, 'Data'));
  fs.writeFileSync(path.join(game, 'SkyrimSE.exe'), 'new');
  fs.writeFileSync(path.join(game, 'Data', 'Skyrim.esm'), 'esm');
  assert.deepEqual(backupGameFiles(game).saved, ['SkyrimSE.exe', 'Data/Skyrim.esm']);
  fs.writeFileSync(path.join(game, 'SkyrimSE.exe'), 'downgraded');
  assert.deepEqual(backupGameFiles(game).saved, [], 'the first (original) backup is kept');
  assert.equal(fs.readFileSync(path.join(game, 'OATHBOUND_downgrade_backup', 'SkyrimSE.exe'), 'utf8'), 'new');
});

test('runs DepotDownloader in its own console window and reports its exit code', async () => {
  let opts;
  const spawnImpl = (exe, args, o) => { opts = o; const c = new EventEmitter(); setImmediate(() => c.emit('exit', 0)); return c; };
  assert.equal(await runDepotDownloader({ exe: 'dd.exe', args: [], spawnImpl }), 0);
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, false);
});

test('a DepotDownloader download that is not the official release is refused', async () => {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  const fetchImpl = async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from('tampered'); })() });
  await assert.rejects(ensureDepotDownloader({ toolDir, sevenZipPath: '7za.exe', fetchImpl }), /did not match/);
  assert.equal(fs.existsSync(path.join(toolDir, 'DepotDownloader.exe')), false);
  assert.match(DEPOT_DOWNLOADER.url, /^https:\/\/github\.com\/SteamRE\/DepotDownloader\/releases\/download\//);
});
