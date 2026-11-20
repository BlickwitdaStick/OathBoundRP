import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  ServerModsError,
  createHashCache,
  enableServerPlugins,
  installServerMods,
  planServerModSync,
  validateManifest
} from './server-mods.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const FILES = {
  'SkyUI_SE.esp': 'skyui-esp',
  'SkyUI_SE.bsa': 'skyui-bsa-contents',
  'SKSE/Plugins/skee64.dll': 'dll-bytes'
};

function manifestOf(files = FILES, plugins = ['SkyUI_SE.esp']) {
  return {
    formatVersion: 1,
    version: 'v1',
    plugins,
    totalBytes: Object.values(files).reduce((s, c) => s + c.length, 0),
    files: Object.entries(files).map(([p, c]) => ({ path: p, size: c.length, sha256: sha(c) }))
  };
}

let tmp;
let gamePath;
let server;
let baseUrl;
let served; // path -> body the fake game-api returns

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mods-'));
  gamePath = path.join(tmp, 'Skyrim');
  fs.mkdirSync(path.join(gamePath, 'Data'), { recursive: true });
  served = { ...FILES };
  server = http.createServer((req, res) => {
    const prefix = '/client-mods/files/';
    const rel = req.url.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : null;
    if (rel === null || !(rel in served)) { res.statusCode = 404; return res.end(); }
    res.end(served[rel]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const dataFile = (rel) => path.join(gamePath, 'Data', ...rel.split('/'));

describe('validateManifest', () => {
  test('accepts a well-formed manifest', () => {
    assert.ok(validateManifest(manifestOf()));
  });

  test('refuses anything that could escape Data/ or clobber the SkyMP client', () => {
    const bad = (p) => () => validateManifest(manifestOf({ [p]: 'x' }, []));
    for (const p of ['../evil.dll', 'Platform/Plugins/skymp5-client.js', 'SKSE/Plugins/MpClientPlugin.dll',
      'SKSE/Plugins/SkyrimPlatform.dll', 'Skyrim.esm', 'C:/Windows/x.dll', 'a\\b.esp']) {
      assert.throws(bad(p), ServerModsError, p);
    }
  });

  test('refuses duplicates, bad hashes and plugins that are not in the file list', () => {
    const m = manifestOf();
    assert.throws(() => validateManifest({ ...m, files: [...m.files, { ...m.files[0], path: m.files[0].path.toUpperCase() }] }), /Duplicate/);
    assert.throws(() => validateManifest({ ...m, files: [{ ...m.files[0], sha256: 'abc' }] }), /Invalid entry/);
    assert.throws(() => validateManifest({ ...m, plugins: ['Missing.esp'] }), /Invalid plugin/);
    assert.throws(() => validateManifest({ ...m, formatVersion: 2 }), /unknown/);
  });
});

describe('planServerModSync', () => {
  test('everything missing on a clean install', async () => {
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    assert.equal(plan.toDownload.length, 3);
    assert.equal(plan.upToDate, 0);
    assert.equal(plan.totalBytes, manifestOf().totalBytes);
  });

  test('matching files are up to date; changed or same-size-different files are re-downloaded', async () => {
    fs.writeFileSync(dataFile('SkyUI_SE.esp'), FILES['SkyUI_SE.esp']);
    fs.mkdirSync(path.dirname(dataFile('SKSE/Plugins/skee64.dll')), { recursive: true });
    fs.writeFileSync(dataFile('SKSE/Plugins/skee64.dll'), 'dll-bytez'); // same size, different bytes
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    assert.deepEqual(plan.toDownload.map(f => f.path).sort(), ['SKSE/Plugins/skee64.dll', 'SkyUI_SE.bsa']);
    assert.equal(plan.upToDate, 1);
  });

  test('hash cache skips re-hashing unchanged files (size + mtime)', async () => {
    const cacheFile = path.join(tmp, 'cache.json');
    fs.writeFileSync(dataFile('SkyUI_SE.esp'), FILES['SkyUI_SE.esp']);
    const cache = createHashCache(cacheFile);
    await planServerModSync({ manifest: manifestOf(), gamePath, hashCache: cache });
    cache.save();
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(Object.values(cached)[0].sha256, sha(FILES['SkyUI_SE.esp']));
  });
});

describe('installServerMods', () => {
  test('downloads, verifies and installs into Data/, creating folders', async () => {
    const manifest = manifestOf();
    const plan = await planServerModSync({ manifest, gamePath });
    const progress = [];
    const res = await installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload, onProgress: p => progress.push(p) });
    assert.equal(res.installed.length, 3);
    for (const [rel, body] of Object.entries(FILES)) assert.equal(fs.readFileSync(dataFile(rel), 'utf8'), body);
    assert.equal(progress.at(-1).bytesDone, manifest.totalBytes);
    const after = await planServerModSync({ manifest, gamePath });
    assert.equal(after.toDownload.length, 0);
  });

  test('a corrupted download is rejected and the old file stays intact', async () => {
    fs.writeFileSync(dataFile('SkyUI_SE.esp'), 'old-version');
    served['SkyUI_SE.esp'] = 'tampered!'; // same length as the real file
    const manifest = manifestOf();
    const plan = await planServerModSync({ manifest, gamePath });
    await assert.rejects(
      installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload.filter(f => f.path === 'SkyUI_SE.esp') }),
      (e) => e instanceof ServerModsError && e.code === 'VERIFY_FAILED'
    );
    assert.equal(fs.readFileSync(dataFile('SkyUI_SE.esp'), 'utf8'), 'old-version');
    assert.deepEqual(fs.readdirSync(path.join(gamePath, 'Data')).filter(n => n.includes('oathbound-download')), []);
  });

  test('oversized responses are cut off', async () => {
    served['SkyUI_SE.esp'] = 'skyui-esp-and-a-lot-more';
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    await assert.rejects(
      installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload.filter(f => f.path === 'SkyUI_SE.esp') }),
      /larger than the manifest/
    );
  });

  test('a busy server (429 + Retry-After) is retried, not fatal', async () => {
    // First two requests for every file get 429; then the server serves normally.
    const busy = new Map();
    const realFetch = globalThis.fetch;
    const waits = [];
    const fetchImpl = async (url) => {
      const n = (busy.get(url) || 0) + 1;
      busy.set(url, n);
      if (n <= 2) return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': '10' } });
      return realFetch(url);
    };
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    const res = await installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload, fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(res.installed.length, 3);
    assert.ok(waits.length === 6 && waits.every(ms => ms === 10000), 'honors Retry-After (10s) twice per file');
  });

  test('gives up after maxAttempts on a server that stays busy', async () => {
    const fetchImpl = async () => new Response('', { status: 503 });
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    await assert.rejects(
      installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload, fetchImpl, sleep: async () => {}, maxAttempts: 3 }),
      (e) => e.code === 'DOWNLOAD_FAILED' && /503/.test(e.message)
    );
  });

  test('HTTP errors surface as DOWNLOAD_FAILED', async () => {
    delete served['SkyUI_SE.bsa'];
    const plan = await planServerModSync({ manifest: manifestOf(), gamePath });
    await assert.rejects(
      installServerMods({ gamePath, baseUrl, toDownload: plan.toDownload.filter(f => f.path === 'SkyUI_SE.bsa') }),
      (e) => e.code === 'DOWNLOAD_FAILED' && /404/.test(e.message)
    );
  });
});

describe('enableServerPlugins', () => {
  function lists(pluginsTxt, loadOrderTxt) {
    fs.writeFileSync(path.join(gamePath, 'OATHBOUND_plugins.txt'), pluginsTxt);
    fs.writeFileSync(path.join(gamePath, 'OATHBOUND_loadorder.txt'), loadOrderTxt);
  }
  const read = (n) => fs.readFileSync(path.join(gamePath, n), 'utf8').split(/\r?\n/).filter(Boolean);

  test('appends the server plugins enabled, in order, after the existing lines', () => {
    lists('*Skyrim.esm\r\n*Update.esm\r\n', 'Skyrim.esm\r\nUpdate.esm\r\n');
    const r = enableServerPlugins({ gamePath, plugins: ['RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp'] });
    assert.equal(r.changed, true);
    assert.deepEqual(read('OATHBOUND_plugins.txt'), ['*Skyrim.esm', '*Update.esm', '*RaceMenu.esp', '*RaceMenuPlugin.esp', '*SkyUI_SE.esp']);
    assert.deepEqual(read('OATHBOUND_loadorder.txt'), ['Skyrim.esm', 'Update.esm', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
    assert.ok(fs.readdirSync(gamePath).some(n => n.startsWith('OATHBOUND_plugins.txt.bak-server-mods-')), 'backed up');
  });

  test('idempotent, and re-enables/reorders a server plugin the user disabled', () => {
    lists('*Skyrim.esm\r\nSkyUI_SE.esp\r\n*Mine.esp\r\n', 'Skyrim.esm\r\nSkyUI_SE.esp\r\nMine.esp\r\n');
    enableServerPlugins({ gamePath, plugins: ['SkyUI_SE.esp'] });
    assert.deepEqual(read('OATHBOUND_plugins.txt'), ['*Skyrim.esm', '*Mine.esp', '*SkyUI_SE.esp']);
    assert.equal(enableServerPlugins({ gamePath, plugins: ['SkyUI_SE.esp'] }).changed, false);
  });

  test('does nothing when the OATHBOUND lists do not exist', () => {
    assert.equal(enableServerPlugins({ gamePath, plugins: ['SkyUI_SE.esp'] }).changed, false);
    assert.ok(!fs.existsSync(path.join(gamePath, 'OATHBOUND_plugins.txt')));
  });
});

describe('base-game plugins (Creation Club masters)', () => {
  const sha64 = 'a'.repeat(64);
  const withBase = () => ({
    ...manifestOf(),
    plugins: ['ccBGSSSE001-Fish.esm', 'SkyUI_SE.esp'],
    basePlugins: [{ name: 'ccBGSSSE001-Fish.esm', size: 10, sha256: sha64 }]
  });

  test('a base plugin may be in the plugin list without being a hosted file', () => {
    assert.ok(validateManifest(withBase()));
  });

  test('unsafe or unknown base entries are refused', () => {
    assert.throws(() => validateManifest({ ...withBase(), basePlugins: [{ name: '../x.esm', size: 1, sha256: sha64 }] }), /base-game plugin/);
    assert.throws(() => validateManifest({ ...withBase(), basePlugins: [] }), /Invalid plugin/);
  });

  test('plan reports base plugins the player lacks (they are never downloaded)', async () => {
    let plan = await planServerModSync({ manifest: withBase(), gamePath });
    assert.deepEqual(plan.missingBase, ['ccBGSSSE001-Fish.esm']);
    assert.ok(!plan.toDownload.some(f => f.path === 'ccBGSSSE001-Fish.esm'));
    fs.writeFileSync(dataFile('ccBGSSSE001-Fish.esm'), 'present');
    plan = await planServerModSync({ manifest: withBase(), gamePath });
    assert.deepEqual(plan.missingBase, []);
  });

  test('enableServerPlugins enables base plugins in manifest order too', () => {
    fs.writeFileSync(path.join(gamePath, 'OATHBOUND_plugins.txt'), '*Skyrim.esm\r\n');
    fs.writeFileSync(path.join(gamePath, 'OATHBOUND_loadorder.txt'), 'Skyrim.esm\r\n');
    enableServerPlugins({ gamePath, plugins: withBase().plugins });
    const lines = fs.readFileSync(path.join(gamePath, 'OATHBOUND_plugins.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    assert.deepEqual(lines, ['*Skyrim.esm', '*ccBGSSSE001-Fish.esm', '*SkyUI_SE.esp']);
  });
});
