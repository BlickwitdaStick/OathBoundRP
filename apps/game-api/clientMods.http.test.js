'use strict';

/**
 * HTTP routes for server-hosted mods: GET /client-mods/manifest.json and
 * GET /client-mods/files/<path>. Runs in its own process (node --test) so the
 * env vars below are read when server.js is first required.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-mods-http-'));
const modsDir = path.join(tmp, 'client-mods');
fs.mkdirSync(path.join(modsDir, 'SKSE', 'Plugins'), { recursive: true });
fs.writeFileSync(path.join(modsDir, 'SkyUI_SE.esp'), 'skyui-esp');
fs.writeFileSync(path.join(modsDir, 'SKSE', 'Plugins', 'skee64.dll'), 'dll-bytes');
fs.writeFileSync(path.join(modsDir, 'Unlisted.txt'), 'not in manifest');
fs.writeFileSync(path.join(tmp, 'secret.json'), '{"secret":true}');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const manifest = {
  formatVersion: 1,
  version: 'abc',
  plugins: ['SkyUI_SE.esp'],
  totalBytes: 18,
  files: [
    { path: 'SKSE/Plugins/skee64.dll', size: 9, sha256: sha('dll-bytes') },
    { path: 'SkyUI_SE.esp', size: 9, sha256: sha('skyui-esp') }
  ]
};
const manifestPath = path.join(tmp, 'client-mods-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-secret-not-used-here';
process.env.CLIENT_MODS_DIR = modsDir;
process.env.CLIENT_MODS_MANIFEST_PATH = manifestPath;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('manifest is served as-is, uncached', async () => {
  const res = await fetch(`${baseUrl}/client-mods/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), manifest);
});

test('listed files are served byte-for-byte, nested paths included', async () => {
  const esp = await fetch(`${baseUrl}/client-mods/files/SkyUI_SE.esp`);
  assert.equal(esp.status, 200);
  assert.equal(await esp.text(), 'skyui-esp');
  assert.equal(esp.headers.get('x-content-sha256'), sha('skyui-esp'));

  const dll = await fetch(`${baseUrl}/client-mods/files/SKSE/Plugins/skee64.dll`);
  assert.equal(dll.status, 200);
  assert.equal(await dll.text(), 'dll-bytes');
});

test('files not in the manifest and traversal attempts are 404', async () => {
  for (const p of ['Unlisted.txt', '..%2Fsecret.json', '%2E%2E/secret.json', 'SKSE%5C..%5C..%5Csecret.json', 'nope.esp']) {
    const res = await fetch(`${baseUrl}/client-mods/files/${p}`);
    assert.equal(res.status, 404, p);
  }
});

test('corrupt manifest answers 503 instead of an empty list', async () => {
  fs.writeFileSync(manifestPath, '{broken');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(manifestPath, future, future);
  const res = await fetch(`${baseUrl}/client-mods/manifest.json`);
  assert.equal(res.status, 503);
});
