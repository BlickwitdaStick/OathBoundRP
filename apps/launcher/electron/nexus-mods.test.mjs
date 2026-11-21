import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  nexusSourcesOf, planNexusDownloads, parseNxmUrl, nexusFilePageUrl, createNexusApi,
  downloadArchive, parse7zList, matchArchiveEntries, extractProvided
} from './nexus-mods.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const file = (p, content) => ({ path: p, size: Buffer.byteLength(content), sha256: sha(content) });

const manifest = {
  formatVersion: 1,
  files: [file('SkyUI_SE.esp', 'esp'), file('SkyUI_SE.bsa', 'bsa-data'), file('OATHBOUND.esp', 'ours')],
  plugins: ['SkyUI_SE.esp'],
  nexus: [
    { id: 'skyui', name: 'SkyUI', modId: 12604, fileId: 749043, fileName: 'SkyUI-12604-6-11.zip', size: 100,
      provides: [{ src: 'SkyUI_SE.esp', path: 'SkyUI_SE.esp' }, { src: 'SkyUI_SE.bsa', path: 'SkyUI_SE.bsa' },
        { src: 'x.esp', path: 'NotInManifest.esp' }] },
    { id: 'bad', modId: 1, fileId: 2, fileName: '../evil.zip', size: 1, provides: [{ src: 'a', path: 'SkyUI_SE.esp' }] },
    { id: 'neg', modId: 1, fileId: 2, fileName: 'x.7z', size: -1, provides: [{ src: 'a', path: 'SkyUI_SE.esp' }] }
  ]
};

test('nexusSourcesOf keeps valid entries and only manifest files', () => {
  const s = nexusSourcesOf(manifest);
  assert.equal(s.length, 1);
  assert.equal(s[0].game, 'skyrimspecialedition');
  assert.deepEqual(s[0].provides.map(p => p.path), ['SkyUI_SE.esp', 'SkyUI_SE.bsa']);
  assert.equal(s[0].provides[0].sha256, sha('esp'));
  assert.deepEqual(nexusSourcesOf({ files: [] }), []);
});

test('planNexusDownloads splits Nexus and server files', () => {
  const sources = nexusSourcesOf(manifest);
  const plan = planNexusDownloads({ sources, toDownload: manifest.files });
  assert.equal(plan.archives.length, 1);
  assert.deepEqual(plan.remaining.map(f => f.path), ['OATHBOUND.esp']);
  assert.equal(plan.nexusBytes, 100);
  // Nothing missing from the archive: no download.
  const none = planNexusDownloads({ sources, toDownload: [manifest.files[2]] });
  assert.equal(none.archives.length, 0);
});

test('planNexusDownloads skips a huge archive for a few small files', () => {
  const src = { ...nexusSourcesOf(manifest)[0], size: 7e9 };
  const plan = planNexusDownloads({ sources: [src], toDownload: [manifest.files[0]] });
  assert.equal(plan.archives.length, 0);
  assert.equal(plan.remaining.length, 1);
});

test('parseNxmUrl', () => {
  const n = parseNxmUrl('nxm://SkyrimSpecialEdition/mods/12604/files/749043?key=abc&expires=1700000000&user_id=5');
  assert.deepEqual(n, { game: 'skyrimspecialedition', modId: 12604, fileId: 749043, key: 'abc', expires: '1700000000' });
  assert.equal(parseNxmUrl('https://x/mods/1/files/2'), null);
  assert.equal(parseNxmUrl('nxm://skyrimspecialedition/collections/abc'), null);
  assert.equal(parseNxmUrl('not a url'), null);
});

test('nexusFilePageUrl', () => {
  assert.equal(nexusFilePageUrl({ game: 'skyrimspecialedition', modId: 1, fileId: 2 }),
    'https://www.nexusmods.com/skyrimspecialedition/mods/1?tab=files&file_id=2&nmm=1');
});

test('Nexus API: validate and download links (premium and nxm)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    if (url.endsWith('/v1/users/validate.json')) return new Response(JSON.stringify({ name: 'p', is_premium: true }));
    return new Response(JSON.stringify([{ name: 'CDN', URI: 'https://cdn.example/file.zip' }]));
  };
  const api = createNexusApi({ apiKey: 'K', appName: 'A', appVersion: '1', fetchImpl });
  assert.deepEqual(await api.validate(), { name: 'p', isPremium: true });
  const src = { game: 'skyrimspecialedition', modId: 3, fileId: 4 };
  assert.equal(await api.downloadLink(src), 'https://cdn.example/file.zip');
  await api.downloadLink(src, { key: 'k y', expires: '9' });
  assert.equal(calls[2].url, 'https://api.nexusmods.com/v1/games/skyrimspecialedition/mods/3/files/4/download_link.json?key=k%20y&expires=9');
  assert.equal(calls[0].headers.apikey, 'K');
  assert.equal(calls[0].headers['Application-Name'], 'A');
});

test('Nexus API errors are readable', async () => {
  const api = createNexusApi({ apiKey: 'K', appName: 'A', appVersion: '1', fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(api.validate(), e => e.code === 'BAD_KEY');
});

test('downloadArchive checks size and reuses a complete file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dl-'));
  const dest = path.join(dir, 'a.zip');
  await downloadArchive({ url: 'u', dest, expectedSize: 5, fetchImpl: async () => new Response('hello') });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello');
  const again = await downloadArchive({ url: 'u', dest, expectedSize: 5, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(again.reused, true);
  await assert.rejects(
    downloadArchive({ url: 'u', dest: path.join(dir, 'b.zip'), expectedSize: 9, fetchImpl: async () => new Response('hello') }),
    e => e.code === 'VERIFY_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'b.zip.part')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parse7zList and matchArchiveEntries', () => {
  const out = 'Path = Top\nFolder = +\nSize = 0\n\nPath = Top\\Data\\SkyUI_SE.esp\nFolder = -\nSize = 3\n\nPath = other\\SkyUI_SE.bsa\nFolder = -\nSize = 8\n';
  const entries = parse7zList(out);
  assert.deepEqual(entries, [{ path: 'Top/Data/SkyUI_SE.esp', size: 3 }, { path: 'other/SkyUI_SE.bsa', size: 8 }]);
  const provides = nexusSourcesOf(manifest)[0].provides;
  const m = matchArchiveEntries(entries, [{ ...provides[0], src: 'Data/SkyUI_SE.esp' }, { ...provides[1], src: 'SkyUI_SE.bsa' }]);
  assert.deepEqual(m.map(x => x.entry.path), ['Top/Data/SkyUI_SE.esp', 'other/SkyUI_SE.bsa']);
});

const require = createRequire(import.meta.url);
let sevenZip = null;
try { sevenZip = require('7zip-bin').path7za; } catch { sevenZip = null; }

test('extractProvided installs verified files only (real 7-Zip)', { skip: !sevenZip || !fs.existsSync(sevenZip) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-x-'));
  const src = path.join(dir, 'src', 'Mod Top', 'Data');
  fs.mkdirSync(path.join(src, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SkyUI_SE.esp'), 'esp');
  fs.writeFileSync(path.join(src, 'SkyUI_SE.bsa'), 'CHANGED!');
  fs.writeFileSync(path.join(src, 'textures', 'skip me.dds'), 'nope');
  const archive = path.join(dir, 'mod.7z');
  execFileSync(sevenZip, ['a', archive, path.join(dir, 'src', '*')], { stdio: 'ignore' });

  const game = path.join(dir, 'game');
  fs.mkdirSync(path.join(game, 'Data'), { recursive: true });
  const provides = nexusSourcesOf(manifest)[0].provides.map(p => ({ ...p, src: `Data/${p.src}` }));
  const res = await extractProvided({ sevenZipPath: sevenZip, archivePath: archive, provides, gamePath: game, workDir: path.join(dir, 'work') });
  assert.deepEqual(res.installed, ['SkyUI_SE.esp']);
  assert.deepEqual(res.mismatched, ['SkyUI_SE.bsa']);
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'SkyUI_SE.esp'), 'utf8'), 'esp');
  assert.equal(fs.existsSync(path.join(game, 'Data', 'SkyUI_SE.bsa')), false);
  assert.equal(fs.existsSync(path.join(dir, 'work')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
