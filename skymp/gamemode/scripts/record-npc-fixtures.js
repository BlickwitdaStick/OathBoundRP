/**
 * scripts/record-npc-fixtures.js — READ-ONLY recorder for npc-classifier tests
 *
 * Reads the master files and writes the NPC_/LVLN/RACE/FACT records that a few
 * seed NPCs reach (templates, leveled-list entries, races, factions) into
 * `core/fixtures/npc-records.json`, keeping only the fields
 * `core/npc-classifier.js` reads. The test then feeds those bytes through a
 * fake `mp.lookupEspmRecordById`, so the classifier is checked against what
 * Skyrim actually ships, not against bytes someone typed.
 *
 *   node scripts/record-npc-fixtures.js <dataDir>
 *
 * Only opens the plugins for reading. Load order assumed: the five masters.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOAD_ORDER = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
const TYPES = new Set(['NPC_', 'LVLN', 'RACE', 'FACT']);
const KEEP = { NPC_: ['ACBS', 'RNAM', 'TPLT', 'SNAM'], LVLN: ['LVLO'], RACE: ['KWDA', 'DATA'], FACT: [] };
const SEEDS = [
  ['Skyrim.esm', 0x0003decb], // LvlBanditMelee1H  → LCharBanditMelee1H
  ['Skyrim.esm', 0x000b83c1], // LvlWolf           → LCharWolf
  ['Skyrim.esm', 0x0002b35e], // LvlThalmorMelee1H → LCharThalmorMelee1H
  ['Skyrim.esm', 0x0004e50a], // LvlHunter
  ['Dragonborn.esm', 0x02035656] // DLC2EncCultist07NordMSummoner
];

function fieldsOf(data) {
  const out = []; let o = 0; let big = 0;
  while (o + 6 <= data.length) {
    const t = data.toString('latin1', o, o + 4); let sz = data.readUInt16LE(o + 4); o += 6;
    if (t === 'XXXX') { big = data.readUInt32LE(o); o += sz; continue; }
    if (big) { sz = big; big = 0; }
    out.push({ type: t, data: data.subarray(o, o + sz) }); o += sz;
  }
  return out;
}

function readPlugin(file, pluginIdx) {
  const buf = fs.readFileSync(file);
  const hdr = fieldsOf(buf.subarray(24, 24 + buf.readUInt32LE(4)));
  const masters = hdr.filter(f => f.type === 'MAST').map(f => f.data.toString('latin1').replace(/\0.*$/, ''));
  const masterMap = masters.map(m => LOAD_ORDER.indexOf(m)).concat([pluginIdx]);
  const toGlobal = (local) => (((masterMap[local >>> 24] ?? pluginIdx) << 24) | (local & 0xffffff)) >>> 0;
  const records = new Map();
  (function walk(start, end) {
    let o = start;
    while (o < end) {
      const t = buf.toString('latin1', o, o + 4); const size = buf.readUInt32LE(o + 4);
      if (t === 'GRUP') {
        const label = buf.toString('latin1', o + 8, o + 12);
        if (buf.readInt32LE(o + 12) !== 0 || TYPES.has(label)) walk(o + 24, o + size);
        o += size; continue;
      }
      if (TYPES.has(t)) {
        const flags = buf.readUInt32LE(o + 8); const local = buf.readUInt32LE(o + 12);
        let data = buf.subarray(o + 24, o + 24 + size);
        if (flags & 0x40000) data = zlib.inflateSync(data.subarray(4));
        records.set(toGlobal(local), { type: t, local, flags, fields: fieldsOf(data) });
      }
      o += 24 + size;
    }
  })(24 + buf.readUInt32LE(4), buf.length);
  return { masterMap, toGlobal, records };
}

function main(dataDir) {
  const plugins = LOAD_ORDER.map((name, i) => ({ name, ...readPlugin(path.join(dataDir, name), i) }));
  const winning = new Map(); // global id → { plugin, rec }
  for (const p of plugins) for (const [g, rec] of p.records) winning.set(g, { plugin: p, rec });

  const out = { loadOrder: LOAD_ORDER, masterMaps: {}, records: {} };
  for (const p of plugins) out.masterMaps[p.name] = p.masterMap;
  const queue = SEEDS.map(([name, local]) => plugins.find(p => p.name === name).toGlobal(local));
  const u32 = (b, o) => b.readUInt32LE(o);
  while (queue.length) {
    const g = queue.shift();
    const key = '0x' + g.toString(16).padStart(8, '0');
    if (out.records[key] || !winning.has(g)) continue;
    const { plugin, rec } = winning.get(g);
    const edid = rec.fields.find(f => f.type === 'EDID');
    const kept = rec.fields.filter(f => KEEP[rec.type].includes(f.type))
      .map(f => ({ type: f.type, hex: (rec.type === 'RACE' && f.type === 'DATA' ? f.data.subarray(0, 36) : f.data).toString('hex') }));
    out.records[key] = { plugin: plugin.name, type: rec.type, editorId: edid ? edid.data.toString('latin1').replace(/\0.*$/, '') : '', fields: kept };
    const follow = [];
    for (const f of rec.fields) {
      if (rec.type === 'NPC_' && ['RNAM', 'TPLT', 'SNAM'].includes(f.type)) follow.push(u32(f.data, 0));
      if (rec.type === 'LVLN' && f.type === 'LVLO') follow.push(u32(f.data, 4));
    }
    for (const local of follow) queue.push(plugin.toGlobal(local));
  }
  const dest = path.join(__dirname, '..', 'core', 'fixtures', 'npc-records.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(out.records).length} records to ${dest}`);
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node scripts/record-npc-fixtures.js <dataDir>'); process.exit(2); }
  main(process.argv[2]);
}
