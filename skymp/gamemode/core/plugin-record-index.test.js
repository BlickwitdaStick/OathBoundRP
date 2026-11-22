/**
 * core/plugin-record-index.test.js
 *
 * The item/NPC index of the F8 admin panel, against synthetic plugins built
 * here byte by byte (TES4 header, top-level GRUPs, records, fields): master
 * mapping to global ids, override order, compressed records, localized names,
 * skipped groups, and the search ranking.
 *
 * Does NOT prove the parser reads the real Skyrim.esm: verify in game (see
 * docs/admin/F8_ADMIN_PANEL.md).
 *
 * Run: node --test core/plugin-record-index.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { describe, it } = require('node:test');
const idx = require('./plugin-record-index');

// ── synthetic plugin builder ────────────────────────────────────────────────
function field(type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(`${data}\0`, 'latin1');
  const head = Buffer.alloc(6);
  head.write(type, 0, 'latin1');
  head.writeUInt16LE(buf.length, 4);
  return Buffer.concat([head, buf]);
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function record(type, formId, fields, { flags = 0, compress = false } = {}) {
  let data = Buffer.concat(fields);
  if (compress) {
    data = Buffer.concat([u32(data.length), zlib.deflateSync(data)]);
    flags |= 0x00040000;
  }
  const head = Buffer.alloc(24);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  head.writeUInt32LE(flags >>> 0, 8);
  head.writeUInt32LE(formId >>> 0, 12);
  return Buffer.concat([head, data]);
}

function group(label, records) {
  const body = Buffer.concat(records);
  const head = Buffer.alloc(24);
  head.write('GRUP', 0, 'latin1');
  head.writeUInt32LE(body.length + 24, 4);
  head.write(label, 8, 'latin1');
  return Buffer.concat([head, body]);
}

function plugin({ masters = [], localized = false }, groups) {
  const fields = [field('HEDR', Buffer.alloc(12))];
  for (const m of masters) fields.push(field('MAST', m), field('DATA', Buffer.alloc(8)));
  const tes4 = record('TES4', 0, fields, { flags: (localized ? 0x80 : 0) | 0x1 });
  return Buffer.concat([tes4, ...groups]);
}

const LOAD = new Map([['skyrim.esm', 0], ['update.esm', 1], ['mymod.esp', 2]]);

describe('plugin-record-index: parsing', () => {
  it('reads masters and the localized flag from TES4', () => {
    const buf = plugin({ masters: ['Skyrim.esm', 'Update.esm'], localized: true }, []);
    const h = idx.parseHeader(buf);
    assert.deepStrictEqual(h.masters, ['Skyrim.esm', 'Update.esm']);
    assert.strictEqual(h.localized, true);
  });

  it('maps record ids through the master list to global ids', () => {
    // MyMod.esp: masters [Skyrim.esm, Update.esm]; 0x00 = Skyrim, 0x01 = Update, 0x02 = itself.
    assert.strictEqual(idx.toGlobalId(0x00012eb7, ['Skyrim.esm', 'Update.esm'], 'MyMod.esp', LOAD), 0x00012eb7);
    assert.strictEqual(idx.toGlobalId(0x01000801, ['Skyrim.esm', 'Update.esm'], 'MyMod.esp', LOAD), 0x01000801);
    assert.strictEqual(idx.toGlobalId(0x02000d62, ['Skyrim.esm', 'Update.esm'], 'MyMod.esp', LOAD), 0x02000d62);
    assert.strictEqual(idx.toGlobalId(0x00000d62, [], 'Unknown.esp', LOAD), null, 'plugin not in the load order');
  });

  it('collects item and NPC records, skips other groups and deleted records', () => {
    const buf = plugin({}, [
      group('WEAP', [
        record('WEAP', 0x00012eb7, [field('EDID', 'IronSword'), field('FULL', 'Iron Sword')]),
        record('WEAP', 0x00012eb8, [field('EDID', 'DeletedSword'), field('FULL', 'Gone')], { flags: 0x20 })
      ]),
      group('CELL', [record('CELL', 0x0000003c, [field('EDID', 'Tamriel')])]),
      group('NPC_', [record('NPC_', 0x00023ab7, [field('EDID', 'WolfRace'), field('FULL', 'Wolf')], { compress: true })])
    ]);
    const out = idx.parsePluginBuffer(buf, 'Skyrim.esm', LOAD);
    assert.deepStrictEqual(out.map((e) => [e.type, e.id, e.editorId, e.name]), [
      ['WEAP', 0x00012eb7, 'IronSword', 'Iron Sword'],
      ['NPC_', 0x00023ab7, 'WolfRace', 'Wolf']
    ]);
  });

  it('localized plugins keep the FULL string id for later resolution', () => {
    const buf = plugin({ localized: true }, [group('MISC', [record('MISC', 0x0000000f, [field('EDID', 'Gold001'), field('FULL', u32(0x1234))])])]);
    const [e] = idx.parsePluginBuffer(buf, 'Skyrim.esm', LOAD);
    assert.strictEqual(e.name, null);
    assert.strictEqual(e.nameStringId, 0x1234);
  });

  it('streams real files: same result as the buffer parser, overrides by load order, localized names resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathbound-plugins-'));
    try {
      fs.writeFileSync(path.join(dir, 'Skyrim.esm'), plugin({ localized: true }, [
        group('WEAP', [record('WEAP', 0x00012eb7, [field('EDID', 'IronSword'), field('FULL', u32(7))])]),
        group('NPC_', [record('NPC_', 0x00023ab7, [field('EDID', 'EncWolf'), field('FULL', u32(8))])])
      ]));
      fs.writeFileSync(path.join(dir, 'MyMod.esp'), plugin({ masters: ['Skyrim.esm'] }, [
        // Override of Skyrim's iron sword, plus a new item of its own.
        group('WEAP', [record('WEAP', 0x00012eb7, [field('EDID', 'IronSword'), field('FULL', 'Iron Sword of Testing')])]),
        group('MISC', [record('MISC', 0x01000800, [field('EDID', 'MyCoin'), field('FULL', 'Odd Coin')])])
      ]));
      const files = [
        { name: 'Skyrim.esm', path: path.join(dir, 'Skyrim.esm') },
        { name: 'MyMod.esp', path: path.join(dir, 'MyMod.esp') }
      ];
      const names = { [0x00023ab7]: 'Wolf' };
      const index = await idx.buildIndex(files, { resolveName: (id) => names[id] });
      const byId = new Map(index.entries.map((e) => [e.id, e]));
      assert.strictEqual(index.errors.length, 0);
      assert.strictEqual(byId.get(0x00012eb7).name, 'Iron Sword of Testing', 'later plugin wins');
      assert.strictEqual(byId.get(0x00012eb7).plugin, 'MyMod.esp');
      assert.strictEqual(byId.get(0x01000800).name, 'Odd Coin');
      assert.strictEqual(byId.get(0x00023ab7).name, 'Wolf', 'localized name via getLocalizedString');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing plugin file is reported, the others still load', async () => {
    const index = await idx.buildIndex([{ name: 'Nope.esp', path: path.join(os.tmpdir(), 'definitely-missing-plugin.esp') }]);
    assert.strictEqual(index.entries.length, 0);
    assert.strictEqual(index.errors.length, 1);
  });

  it('server settings → absolute plugin paths', () => {
    const fakeMp = { getServerSettings: () => ({ dataDir: 'data', loadOrder: ['Skyrim.esm', 'C:/abs/MyMod.esp'] }) };
    const p = idx.pluginsFromServerSettings(fakeMp, path.resolve('/srv/server'));
    assert.strictEqual(p.files[0].name, 'Skyrim.esm');
    assert.strictEqual(p.files[0].path, path.resolve('/srv/server', 'data', 'Skyrim.esm'));
    assert.strictEqual(p.files[1].name, 'MyMod.esp');
    assert.strictEqual(idx.pluginsFromServerSettings({}), null);
    assert.strictEqual(idx.pluginsFromServerSettings({ getServerSettings: () => ({}) }), null);
  });
});

describe('plugin-record-index: search', () => {
  const entries = [
    { id: 0x12eb7, type: 'WEAP', editorId: 'IronSword', name: 'Iron Sword' },
    { id: 0x13989, type: 'WEAP', editorId: 'SteelSword', name: 'Steel Sword' },
    { id: 0x1397e, type: 'WEAP', editorId: 'IronDagger', name: 'Iron Dagger' },
    { id: 0x5ad9e, type: 'MISC', editorId: 'IngotIron', name: 'Iron Ingot' },
    { id: 0x23ab7, type: 'NPC_', editorId: 'EncWolf', name: 'Wolf' },
    { id: 0x0f, type: 'MISC', editorId: 'Gold001', name: null }
  ].map((e) => ({ ...e, plugin: 'Skyrim.esm', search: `${(e.name || '').toLowerCase()} ${e.editorId.toLowerCase()}` }));

  it('every word must match; exact and prefix matches rank first', () => {
    const r = idx.search(entries, { query: 'iron', types: idx.ITEM_TYPES });
    assert.deepStrictEqual(r.map((x) => x.name), ['Iron Dagger', 'Iron Ingot', 'Iron Sword']);
    assert.deepStrictEqual(idx.search(entries, { query: 'iron sword' }).map((x) => x.name), ['Iron Sword']);
  });

  it('filters by type (items never return NPCs and vice versa)', () => {
    assert.deepStrictEqual(idx.search(entries, { query: 'wolf', types: idx.ITEM_TYPES }), []);
    assert.deepStrictEqual(idx.search(entries, { query: 'wolf', types: idx.NPC_TYPES }).map((x) => x.baseId), [0x23ab7]);
    assert.deepStrictEqual(idx.search(entries, { query: 'iron', types: ['MISC'] }).map((x) => x.name), ['Iron Ingot']);
  });

  it('hex FormIDs match by id; editor ids are searchable; unnamed records show their editor id', () => {
    assert.deepStrictEqual(idx.search(entries, { query: '0x00012eb7' }).map((x) => x.name), ['Iron Sword']);
    assert.deepStrictEqual(idx.search(entries, { query: '12eb7' }).map((x) => x.name), ['Iron Sword']);
    const gold = idx.search(entries, { query: 'gold001' });
    assert.strictEqual(gold[0].name, 'Gold001');
    assert.strictEqual(gold[0].idHex, '0x0000000f');
  });

  it('results are capped', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, type: 'MISC', editorId: `Thing${i}`, name: `Thing ${i}`, search: `thing ${i} thing${i}` }));
    assert.strictEqual(idx.search(many, { query: 'thing' }).length, idx.MAX_RESULTS);
    assert.strictEqual(idx.search(many, { query: 'thing', limit: 5 }).length, 5);
  });

  it('pages: every result is reachable, with the total; offsets past the end land on the last page', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, type: 'ARMO', editorId: `Armor${i}`, name: `Armor ${String(i).padStart(3, '0')}`, search: `armor ${i}` }))
      .concat([{ id: 999, type: 'WEAP', editorId: 'Sword', name: 'Armor Sword', search: 'armor sword sword' }]);
    const p1 = idx.searchPage(many, { query: '', types: ['ARMO'] });
    assert.deepStrictEqual([p1.total, p1.offset, p1.limit, p1.results.length], [120, 0, 50, 50]);
    const p3 = idx.searchPage(many, { query: '', types: ['ARMO'], offset: 100 });
    assert.deepStrictEqual([p3.offset, p3.results.length, p3.results[19].name], [100, 20, 'Armor 119']);
    const seen = new Set([...p1.results, ...idx.searchPage(many, { types: ['ARMO'], offset: 50 }).results, ...p3.results].map((r) => r.baseId));
    assert.strictEqual(seen.size, 120, 'no result is skipped or repeated across pages');
    assert.strictEqual(idx.searchPage(many, { types: ['ARMO'], offset: 9999 }).offset, 100);
    assert.ok(!idx.searchPage(many, { query: 'armor', types: ['ARMO'] }).results.some((r) => r.type === 'WEAP'), 'type filter holds');
  });

  it('createRecordIndex without plugin settings reports unavailable (search returns null)', async () => {
    const ri = idx.createRecordIndex({ mpApi: () => null, log: () => {} });
    assert.strictEqual(await ri.search({ query: 'iron' }), null);
    assert.strictEqual(ri.status().status, 'unavailable');
  });
});

describe('plugin-record-index: light (ESL) plugins', () => {
  const { buildLoadIndex, toGlobalId } = require('./plugin-record-index');
  // The real order on this server: light plugins sit between full ones.
  const loadIndex = buildLoadIndex([
    { name: 'Skyrim.esm', light: false },
    { name: 'Update.esm', light: false },
    { name: '_ResourcePack.esl', light: true },
    { name: 'ccbgssse001-fish.esm', light: false },
    { name: 'ccbgssse037-curios.esl', light: true },
    { name: 'unofficial skyrim special edition patch.esp', light: false },
    { name: 'FortSnowhawk_rebuild.esp', light: true },
    { name: 'Immersive Weapons.esp', light: false }
  ]);

  it('full plugins skip light ones when numbering', () => {
    assert.equal(loadIndex.get('ccbgssse001-fish.esm'), 2);
    assert.equal(loadIndex.get('unofficial skyrim special edition patch.esp'), 3);
    assert.equal(loadIndex.get('immersive weapons.esp'), 4);
  });

  it('light plugins take FE ids in their own sequence', () => {
    assert.equal(toGlobalId(0x00000801, [], '_ResourcePack.esl', loadIndex), 0xfe000801);
    assert.equal(toGlobalId(0x01000805, ['Skyrim.esm'], 'ccbgssse037-curios.esl', loadIndex), 0xfe001805);
    // an id in a light plugin that points at its master stays the master's
    assert.equal(toGlobalId(0x00000805, ['Skyrim.esm'], 'ccbgssse037-curios.esl', loadIndex), 0x00000805);
    assert.equal(toGlobalId(0x01000abc, ['Skyrim.esm'], 'FortSnowhawk_rebuild.esp', loadIndex), 0xfe002abc);
  });

  it('a mod item after the light plugins gets the index the server uses', () => {
    // Immersive Weapons record 0x01012345 (own record: master list has 1 entry)
    assert.equal(toGlobalId(0x01012345, ['Skyrim.esm'], 'Immersive Weapons.esp', loadIndex), 0x04012345);
    // ...and a Skyrim.esm record it overrides keeps its vanilla id
    assert.equal(toGlobalId(0x00012eb7, ['Skyrim.esm'], 'Immersive Weapons.esp', loadIndex), 0x00012eb7);
  });
});
