'use strict';

/**
 * clientMods.js + scripts/sync-client-mods.js: the folder of mods the server
 * hosts becomes a manifest, plugins land in the SkyMP server's load order and
 * data dir, and mods.json follows — without touching base masters or manual
 * entries, and with backups of what is rewritten.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  isSafeRelativePath, orderPlugins, buildClientModsManifest,
  validateClientModsManifest, resolveServedFile
} = require('./clientMods');
const { syncClientMods } = require('./scripts/sync-client-mods');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Plugin with masters: TES4 header + MAST subrecords (what readPluginHeader parses). */
function pluginWithMasters(tag, masters, flags = 0) {
  const subs = Buffer.concat(masters.map((m) => {
    const name = Buffer.from(m + '\0', 'latin1');
    const h = Buffer.alloc(6);
    h.write('MAST', 0, 'latin1');
    h.writeUInt16LE(name.length, 4);
    return Buffer.concat([h, name]);
  }));
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(subs.length, 4);
  head.writeUInt32LE(flags, 8);
  return Buffer.concat([head, subs, Buffer.from(tag)]);
}

/** Minimal valid plugin: TES4 record header (flags at byte 8) + a tag so hashes differ. */
function plugin(tag, flags = 0) {
  const h = Buffer.alloc(24);
  h.write('TES4', 0, 'latin1');
  h.writeUInt32LE(flags, 8);
  return Buffer.concat([h, Buffer.from(tag)]);
}
const BASE = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

let tmp;
function write(rel, contents) {
  const full = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

function fixture() {
  write('client-mods/SkyUI_SE.esp', plugin('skyui-esp', 0x200)); // ESL-flagged, like the real one
  write('client-mods/SkyUI_SE.bsa', 'skyui-bsa');
  write('client-mods/RaceMenu.esp', plugin('rm-esp'));
  write('client-mods/RaceMenuPlugin.esp', plugin('rmp-esp'));
  write('client-mods/SKSE/Plugins/skee64.dll', 'dll');
  write('client-mods/README.txt', 'docs');
  write('client-mods/ModderResource/IPluginInterface.h', 'header');
  for (const m of BASE) write(`server/data/${m}`, `vanilla-${m}`);
  write('server/server-settings.json', JSON.stringify({ name: 'x', dataDir: 'data', loadOrder: BASE }, null, 2));
  return {
    clientModsDir: path.join(tmp, 'client-mods'),
    serverSettingsPath: path.join(tmp, 'server', 'server-settings.json'),
    modsJsonPath: path.join(tmp, 'mods.json'),
    manifestOutPath: path.join(tmp, 'client-mods-manifest.json'),
    hashCachePath: path.join(tmp, 'hash-cache.json'),
    // Stock-server mode unless a test says otherwise; never the machine's own
    // skymp/config/client-mods.local.json.
    serverSupportsLightPlugins: false
  };
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-mods-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('clientMods: paths and order', () => {
  test('only plain relative paths inside the folder are safe', () => {
    for (const ok of ['SkyUI_SE.esp', 'SKSE/Plugins/skee64.dll', 'interface/skyui/a b.swf']) assert.ok(isSafeRelativePath(ok), ok);
    for (const bad of ['', '../x', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'con.', 'x?y', 'a/b ']) {
      assert.ok(!isSafeRelativePath(bad), bad);
    }
  });

  test('default server order: masters, then plugins alphabetically; .esl files never on the server', () => {
    assert.deepEqual(orderPlugins(['SkyUI_SE.esp', 'B.esl', 'RaceMenuPlugin.esp', 'A.esm', 'RaceMenu.esp']),
      ['A.esm', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
  });

  test('load-order.txt wins, and must only name plugins that exist', () => {
    assert.deepEqual(orderPlugins(['A.esp', 'B.esp', 'C.esp'], '# comment\n*C.esp\nA.esp\n'), ['C.esp', 'A.esp', 'B.esp']);
    assert.throws(() => orderPlugins(['A.esp'], 'Missing.esp'), /not in the client-mods folder/);
  });
});

describe('clientMods: light (ESL) plugins', () => {
  const { readPluginFlags } = require('./clientMods');

  test('reads ESM/ESL flags from the TES4 header, not just the extension', () => {
    assert.deepEqual(readPluginFlags(write('a/Light.esp', plugin('x', 0x200))), { esm: false, light: true });
    assert.deepEqual(readPluginFlags(write('a/Master.esp', plugin('x', 0x1))), { esm: true, light: false });
    assert.deepEqual(readPluginFlags(write('a/Plain.esp', plugin('x'))), { esm: false, light: false });
    assert.throws(() => readPluginFlags(write('a/Junk.esp', 'not a plugin')), /TES4/);
  });

  test('light plugins always go last, even when load-order.txt lists them first', () => {
    const flags = (n) => ({ esm: false, light: n.startsWith('L') });
    assert.deepEqual(orderPlugins(['B.esp', 'LSky.esp', 'A.esp'], 'LSky.esp\nB.esp', flags), ['B.esp', 'A.esp', 'LSky.esp']);
  });

  test('on the SERVER a full plugin added after an ESL-flagged one is placed before it', async () => {
    const f = fixture();
    write('client-mods/SMIM-SE-Merged-All.esp', plugin('smim'));
    const m = await buildClientModsManifest(f.clientModsDir);
    assert.deepEqual(m.serverLoadOrder, ['RaceMenu.esp', 'RaceMenuPlugin.esp', 'SMIM-SE-Merged-All.esp', 'SkyUI_SE.esp']);
    assert.deepEqual(m.lightPlugins, ['SkyUI_SE.esp']);
  });
});

describe('clientMods: manifest', () => {
  test('lists files with size and sha256; skips README and modder folders', async () => {
    const f = fixture();
    const m = await buildClientModsManifest(f.clientModsDir);
    assert.deepEqual(m.files.map(x => x.path), [
      'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SKSE/Plugins/skee64.dll', 'SkyUI_SE.bsa', 'SkyUI_SE.esp'
    ]);
    const esp = m.files.find(x => x.path === 'SkyUI_SE.esp');
    assert.equal(esp.sha256, sha(plugin('skyui-esp', 0x200)));
    assert.equal(esp.size, plugin('skyui-esp', 0x200).length);
    assert.deepEqual(m.lightPlugins, ['SkyUI_SE.esp']);
    assert.deepEqual(m.plugins, ['RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
    assert.match(m.version, /^[0-9a-f]{16}$/);
    assert.ok(validateClientModsManifest(m).ok);
  });

  test('dotfiles (e.g. IED .placeholder) are never listed or served', async () => {
    const f = fixture();
    write('client-mods/SKSE/Plugins/IED/Fonts/user/.placeholder', '');
    const m = await buildClientModsManifest(f.clientModsDir);
    assert.ok(!m.files.some(x => x.path.includes('.placeholder')));
  });

  test('version changes when any file changes', async () => {
    const f = fixture();
    const a = await buildClientModsManifest(f.clientModsDir);
    write('client-mods/SKSE/Plugins/skee64.dll', 'dll-v2');
    const b = await buildClientModsManifest(f.clientModsDir);
    assert.notEqual(a.version, b.version);
  });

  test('missing folder = no server mods (valid, empty)', async () => {
    const m = await buildClientModsManifest(path.join(tmp, 'nope'));
    assert.deepEqual(m.files, []);
    assert.ok(validateClientModsManifest(m).ok);
  });

  test('refuses base masters and nested plugins', async () => {
    write('client-mods/Skyrim.esm', plugin('x'));
    await assert.rejects(buildClientModsManifest(path.join(tmp, 'client-mods')), /base game master/);
    fs.rmSync(path.join(tmp, 'client-mods', 'Skyrim.esm'));
    write('client-mods/sub/Nested.esp', plugin('x'));
    await assert.rejects(buildClientModsManifest(path.join(tmp, 'client-mods')), /root of client-mods/);
  });

  test('resolveServedFile only serves manifest entries', async () => {
    const f = fixture();
    const m = await buildClientModsManifest(f.clientModsDir);
    assert.ok(resolveServedFile(f.clientModsDir, m, 'SKSE/Plugins/skee64.dll'));
    assert.equal(resolveServedFile(f.clientModsDir, m, 'README.txt'), null);
    assert.equal(resolveServedFile(f.clientModsDir, m, '../server/server-settings.json'), null);
    assert.equal(resolveServedFile(f.clientModsDir, m, 'ModderResource/IPluginInterface.h'), null);
  });
});

describe('sync-client-mods', () => {
  test('appends plugins after the base masters, copies them, regenerates mods.json', async () => {
    const f = fixture();
    await syncClientMods(f);

    const settings = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    assert.deepEqual(settings.loadOrder, [...BASE, 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
    assert.equal(settings.name, 'x', 'other settings untouched');
    for (const p of ['RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']) {
      assert.ok(fs.existsSync(path.join(tmp, 'server', 'data', p)), `${p} copied to server data`);
    }

    const mods = JSON.parse(fs.readFileSync(f.modsJsonPath, 'utf8'));
    assert.deepEqual(mods.loadOrder, settings.loadOrder);
    assert.equal(mods.hashAlgorithm, 'sha256');
    assert.equal(mods.mods.find(m => m.filename === 'SkyUI_SE.esp').hash, sha(plugin('skyui-esp', 0x200)));
    assert.equal(mods.mods.find(m => m.filename === 'Skyrim.esm').hash, sha('vanilla-Skyrim.esm'));

    const manifest = JSON.parse(fs.readFileSync(f.manifestOutPath, 'utf8'));
    assert.deepEqual(manifest.plugins, ['RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);

    const backups = fs.readdirSync(path.join(tmp, 'server')).filter(n => n.includes('.bak-client-mods-'));
    assert.equal(backups.length, 1, 'server-settings.json backed up once');
  });

  test('re-running with no changes rewrites nothing', async () => {
    const f = fixture();
    await syncClientMods(f);
    const before = fs.readFileSync(f.serverSettingsPath, 'utf8');
    const s = await syncClientMods(f);
    assert.equal(s.loadOrderChanged, false);
    assert.equal(s.copies.length, 0);
    assert.equal(fs.readFileSync(f.serverSettingsPath, 'utf8'), before);
  });

  test('removing a mod takes it out of the load order and moves its plugin aside', async () => {
    const f = fixture();
    await syncClientMods(f);
    fs.rmSync(path.join(f.clientModsDir, 'SkyUI_SE.esp'));
    fs.rmSync(path.join(f.clientModsDir, 'SkyUI_SE.bsa'));
    await syncClientMods(f);
    const settings = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    assert.deepEqual(settings.loadOrder, [...BASE, 'RaceMenu.esp', 'RaceMenuPlugin.esp']);
    const data = fs.readdirSync(path.join(tmp, 'server', 'data'));
    assert.ok(!data.includes('SkyUI_SE.esp'));
    assert.ok(data.some(n => n.startsWith('SkyUI_SE.esp.removed-')), 'moved aside, not deleted');
  });

  test('manual load-order entries the script did not add are never touched', async () => {
    const f = fixture();
    write('server/data/Manual.esp', 'manual');
    const s0 = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    fs.writeFileSync(f.serverSettingsPath, JSON.stringify({ ...s0, loadOrder: [...BASE, 'Manual.esp'] }));
    await syncClientMods(f);
    const settings = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    assert.deepEqual(settings.loadOrder, [...BASE, 'Manual.esp', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
  });

  test('hash cache: unchanged files are not re-hashed, changed ones are', async () => {
    const f = fixture();
    await syncClientMods(f);
    const cache = JSON.parse(fs.readFileSync(f.hashCachePath, 'utf8'));
    assert.ok(cache['SkyUI_SE.bsa'], 'cache written');
    // Poison the cached hash of an unchanged file: a cache hit must be used as-is.
    cache['SkyUI_SE.bsa'].sha256 = 'f'.repeat(64);
    fs.writeFileSync(f.hashCachePath, JSON.stringify(cache));
    const s1 = await syncClientMods({ ...f, check: true });
    assert.equal(s1.manifest.files.find(x => x.path === 'SkyUI_SE.bsa').sha256, 'f'.repeat(64));
    // Changing the file (size differs) forces a fresh hash.
    write('client-mods/SkyUI_SE.bsa', 'skyui-bsa-v2');
    const s2 = await syncClientMods({ ...f, check: true });
    assert.equal(s2.manifest.files.find(x => x.path === 'SkyUI_SE.bsa').sha256, sha('skyui-bsa-v2'));
  });

  test('--check changes nothing', async () => {
    const f = fixture();
    const before = fs.readFileSync(f.serverSettingsPath, 'utf8');
    const s = await syncClientMods({ ...f, check: true });
    assert.equal(s.loadOrderChanged, true);
    assert.equal(fs.readFileSync(f.serverSettingsPath, 'utf8'), before);
    assert.ok(!fs.existsSync(f.modsJsonPath));
    assert.ok(!fs.existsSync(f.manifestOutPath));
  });
});

describe('clientMods: masters, base-game plugins, two load orders', () => {
  const { planLoadOrder, readPluginHeader } = require('./clientMods');
  const BASE5 = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

  test('readPluginHeader reads the master list', () => {
    const p = write('a/Patch.esp', pluginWithMasters('x', ['Skyrim.esm', 'Mod A.esp']));
    assert.deepEqual(readPluginHeader(p), { esm: false, light: false, masters: ['Skyrim.esm', 'Mod A.esp'] });
  });

  test('every plugin loads after its masters, whatever the alphabet says', () => {
    const plan = planLoadOrder([
      { name: 'A Patch.esp', esm: false, light: false, masters: ['Skyrim.esm', 'Z Mod.esp'] },
      { name: 'Z Mod.esp', esm: false, light: false, masters: ['Skyrim.esm'] }
    ]);
    assert.deepEqual(plan.clientOrder, ['Z Mod.esp', 'A Patch.esp']);
  });

  test('USSEP-like: a server plugin that needs a .esl master is refused (SkyMP crashes on it)', () => {
    // Seen on the real server (19/11/2026): "'_ResourcePack.esl' is not a valid esp or esm name",
    // then "unofficial skyrim special edition patch.esp has unresolved dependency (ccqdrsse001-survivalmode.esl)".
    assert.throws(() => planLoadOrder([
      { name: 'USSEP.esp', esm: true, light: false, masters: ['Skyrim.esm', 'cc Fish.esm', 'cc Survival.esl'] },
      { name: 'cc Fish.esm', esm: true, light: false, masters: ['Skyrim.esm'] },
      { name: 'cc Survival.esl', esm: true, light: true, masters: ['Skyrim.esm'] }
    ]), /cannot load \.esl plugins.*USSEP\.esp needs cc Survival\.esl/);
  });

  test('a .esl nothing depends on is client-only: in the game order, never on the server', () => {
    const plan = planLoadOrder([
      { name: 'RaceMenu.esp', esm: false, light: false, masters: ['Skyrim.esm'] },
      { name: 'Hair Pack.esl', esm: true, light: true, masters: ['Skyrim.esm'] }
    ]);
    assert.deepEqual(plan.clientOrder, ['Hair Pack.esl', 'RaceMenu.esp']);
    assert.deepEqual(plan.serverOrder, ['RaceMenu.esp']);
  });

  test('existing plugins keep their order; new ones go after (rule 4)', () => {
    const plan = planLoadOrder([
      { name: 'A New.esp', esm: false, light: false, masters: ['Skyrim.esm'] },
      { name: 'Old Two.esp', esm: false, light: false, masters: ['Skyrim.esm'] },
      { name: 'Old One.esp', esm: false, light: false, masters: ['Skyrim.esm'] }
    ], { preferred: ['Old One.esp', 'Old Two.esp'] });
    assert.deepEqual(plan.clientOrder, ['Old One.esp', 'Old Two.esp', 'A New.esp']);
  });

  test('a missing master is a clear error, not a broken game', () => {
    assert.throws(() => planLoadOrder([{ name: 'P.esp', esm: false, light: false, masters: ['Ghost.esp'] }]), /requires Ghost\.esp/);
  });

  test('sync: base-game masters come from the game Data folder, are copied to the server, never distributed', async () => {
    const f = fixture();
    write('game-data/ccFish.esm', pluginWithMasters('fish', ['Skyrim.esm'], 0x1));
    write('client-mods/FishPatch.esp', pluginWithMasters('fp', ['Skyrim.esm', 'ccFish.esm']));
    const s = await syncClientMods({ ...f, baseDataDir: path.join(tmp, 'game-data') });

    assert.deepEqual(s.manifest.basePlugins.map((b) => b.name), ['ccFish.esm']);
    assert.ok(!s.manifest.files.some((x) => /^cc/.test(x.path)), 'base plugins are not hosted files');
    for (const n of ['ccFish.esm', 'FishPatch.esp']) {
      assert.ok(fs.existsSync(path.join(tmp, 'server', 'data', n)), n + ' copied to server data');
    }
    const settings = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    const mods = JSON.parse(fs.readFileSync(f.modsJsonPath, 'utf8'));
    // Masters first in both; SkyUI_SE.esp is ESL-flagged in the fixture: last on the server.
    assert.deepEqual(settings.loadOrder, [...BASE5, 'ccFish.esm', 'FishPatch.esp', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
    assert.deepEqual(mods.loadOrder, [...BASE5, 'ccFish.esm', 'FishPatch.esp', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
  });

  test('sync: refuses (and writes nothing) when a hosted plugin needs a base .esl', async () => {
    const f = fixture();
    write('game-data/ccSurvival.esl', pluginWithMasters('surv', ['Skyrim.esm']));
    write('client-mods/USSEP.esp', pluginWithMasters('ussep', ['Skyrim.esm', 'ccSurvival.esl'], 0x1));
    const before = fs.readFileSync(f.serverSettingsPath, 'utf8');
    await assert.rejects(syncClientMods({ ...f, baseDataDir: path.join(tmp, 'game-data') }), /cannot load \.esl plugins/);
    assert.equal(fs.readFileSync(f.serverSettingsPath, 'utf8'), before, 'server settings untouched');
  });

  test('sync: a master missing from both client-mods and the game folder stops the sync', async () => {
    const f = fixture();
    write('client-mods/Needs.esp', pluginWithMasters('n', ['Skyrim.esm', 'NotInstalled.esm']));
    await assert.rejects(syncClientMods({ ...f, baseDataDir: path.join(tmp, 'nowhere') }), /NotInstalled\.esm/);
  });
});

describe('clientMods: patched SkyMP with light-plugin support', () => {
  const { planLoadOrder } = require('./clientMods');
  const BASE5 = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

  test('the server loads exactly the game order, .esl files included', () => {
    const plan = planLoadOrder([
      { name: 'USSEP.esp', esm: true, light: false, masters: ['Skyrim.esm', 'cc Survival.esl'] },
      { name: 'cc Survival.esl', esm: true, light: true, masters: ['Skyrim.esm'] },
      { name: 'RaceMenu.esp', esm: false, light: false, masters: ['Skyrim.esm'] }
    ], { serverSupportsLightPlugins: true });
    assert.deepEqual(plan.clientOrder, ['cc Survival.esl', 'USSEP.esp', 'RaceMenu.esp']);
    assert.deepEqual(plan.serverOrder, plan.clientOrder);
    assert.deepEqual(plan.lightPlugins, ['cc Survival.esl']);
  });

  test('sync: USSEP with .esl masters is accepted when the server supports light plugins', async () => {
    const f = fixture();
    write('game-data/ccSurvival.esl', pluginWithMasters('surv', ['Skyrim.esm']));
    write('client-mods/USSEP.esp', pluginWithMasters('ussep', ['Skyrim.esm', 'ccSurvival.esl'], 0x1));
    await syncClientMods({ ...f, baseDataDir: path.join(tmp, 'game-data'), serverSupportsLightPlugins: true });
    const settings = JSON.parse(fs.readFileSync(f.serverSettingsPath, 'utf8'));
    const mods = JSON.parse(fs.readFileSync(f.modsJsonPath, 'utf8'));
    assert.deepEqual(settings.loadOrder, [...BASE5, 'ccSurvival.esl', 'USSEP.esp', 'RaceMenu.esp', 'RaceMenuPlugin.esp', 'SkyUI_SE.esp']);
    assert.deepEqual(mods.loadOrder, settings.loadOrder, 'server and game load the same order');
  });
});
