import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, newestInstaller, isTrustedDownloadUrl, checkLauncherUpdate, downloadInstaller } from './launcher-update.mjs';

const asset = (v, extra = {}) => ({
  name: `OATHBOUND.RP.Launcher.Setup.${v}.exe`,
  size: 3,
  browser_download_url: `https://github.com/BlickwitdaStick/OathBoundRP/releases/download/launcher-v${v}/OATHBOUND.RP.Launcher.Setup.${v}.exe`,
  ...extra
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('v0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.2.3', '0.3.0'), -1);
});

test('picks the newest installer across releases, skipping drafts, prereleases and other files', () => {
  const releases = [
    { tag_name: 'v0.1.0-oathbound', assets: [{ name: 'OATHBOUND-patched-skymp.zip', browser_download_url: 'x' }] },
    { tag_name: 'launcher-v0.2.4', assets: [asset('0.2.4')] },
    { tag_name: 'launcher-v0.2.10', assets: [asset('0.2.10')] },
    { tag_name: 'launcher-v0.9.0', draft: true, assets: [asset('0.9.0')] },
    { tag_name: 'launcher-v0.8.0', prerelease: true, assets: [asset('0.8.0')] }
  ];
  assert.equal(newestInstaller(releases).version, '0.2.10');
  assert.equal(newestInstaller([]), null);
});

test('only this repo\'s GitHub release downloads are trusted', () => {
  assert.ok(isTrustedDownloadUrl(asset('0.2.4').browser_download_url));
  assert.ok(!isTrustedDownloadUrl('https://evil.example/OATHBOUND.RP.Launcher.Setup.0.2.4.exe'));
  assert.ok(!isTrustedDownloadUrl('https://github.com/someone/else/releases/download/x/a.exe'));
  assert.ok(!isTrustedDownloadUrl('http://github.com/BlickwitdaStick/OathBoundRP/releases/download/x/a.exe'));
});

test('check reports an update only when newer than the running launcher', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [{ tag_name: 't', assets: [asset('0.2.4')] }] });
  assert.equal((await checkLauncherUpdate({ currentVersion: '0.2.3', fetchImpl })).available, true);
  assert.equal((await checkLauncherUpdate({ currentVersion: '0.2.4', fetchImpl })).available, false);
});

test('download writes the installer and rejects a short file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-'));
  const body = (bytes) => ({ ok: true, headers: { get: () => String(bytes.length) }, body: (async function* () { yield Buffer.from(bytes); })() });
  const latest = { ...newestInstaller([{ assets: [asset('0.2.4')] }]) };
  const file = await downloadInstaller({ latest, dir, fetchImpl: async () => body('abc') });
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
  await assert.rejects(downloadInstaller({ latest, dir, fetchImpl: async () => body('ab') }), /incomplete/);
  await assert.rejects(downloadInstaller({ latest: { ...latest, url: 'https://evil.example/x.exe' }, dir }), /GitHub releases/);
});
