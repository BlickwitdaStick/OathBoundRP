/**
 * Reads the server load order and collects ARMO / COBJ / skins / keywords.
 * Exports scan() so build-armor-recipes.js and the report share one pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readPlugin, zstring } = require('./esp-read');

const REPO = path.resolve(__dirname, '..', '..');
const CLIENT_MODS = path.join(REPO, 'skymp', 'client-mods');
const GAME_DATA = process.env.SKYRIM_DATA || 'E:/SkyrimRP/Skyrim Special Edition/Data';
const SETTINGS = path.join(REPO, 'skymp', 'server', 'server-settings.json');

const VANILLA = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm',
  '_resourcepack.esl', 'ccbgssse001-fish.esm', 'ccbgssse025-advdsgs.esm', 'ccbgssse037-curios.esl', 'ccqdrsse001-survivalmode.esl']);

/** CTDA: op/flags, comparison, function, params (forms remapped to keys when the function takes one). */
const FORM_PARAM_FUNCS = new Set([448, 47, 182, 69, 72, 559]);
function decodeCtda(d, ref) {
  const op = d.readUInt8(0);
  const fn = d.readUInt16LE(8);
  const p1 = d.readUInt32LE(12);
  return {
    op, fn,
    useGlobal: Boolean(op & 0x04),
    comp: op & 0x04 ? ref(d.readUInt32LE(4)) : d.readFloatLE(4),
    param1: FORM_PARAM_FUNCS.has(fn) ? ref(p1) : p1,
    param2: d.readUInt32LE(16),
    runOn: d.readUInt32LE(20),
    raw: Buffer.from(d)
  };
}

function locate(name) {
  for (const dir of [CLIENT_MODS, GAME_DATA]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadOrder(exclude = []) {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  return s.loadOrder.filter((n) => !skip.has(n.toLowerCase()));
}

function scan({ exclude = [] } = {}) {
  const order = loadOrder(exclude);
  const armors = new Map();   // key -> armor (last override wins, origin kept)
  const cobjMap = new Map(); // COBJ key -> last override {plugin, out, bench, items, conds}
  const skins = new Set();    // keys used as RACE/NPC skin
  const raceArmors = new Set();
  const keywords = new Map(); // key -> edid
  const kwByEdid = new Map();
  const leveled = new Set();  // keys in any LVLI
  const outfits = new Set();  // keys in any OTFT
  const misc = new Map();     // edid -> key for MISC / INGR (materials)
  const plugins = [];

  for (const name of order) {
    const file = locate(name);
    if (!file) { console.warn(`[scan] missing plugin ${name}`); continue; }
    const types = new Set(['ARMO', 'COBJ', 'RACE', 'NPC_', 'KYWD', 'LVLI', 'OTFT', 'MISC', 'INGR', 'ARMA']);
    const header = readPlugin(file, name, types, (rec, hdr) => {
      const f = (t) => rec.fields.find((x) => x.type === t);
      const fs_ = (t) => rec.fields.filter((x) => x.type === t);
      const edidF = f('EDID');
      const edid = edidF ? zstring(edidF.data) : '';
      if (rec.type === 'KYWD') { keywords.set(rec.key, edid); kwByEdid.set(edid, rec.key); return; }
      if (rec.type === 'MISC' || rec.type === 'INGR') { if (edid) misc.set(edid, rec.key); return; }
      if (rec.type === 'RACE') {
        const w = f('WNAM'); if (w) skins.add(rec.ref(w.data.readUInt32LE(0)));
        return;
      }
      if (rec.type === 'NPC_') {
        const w = f('WNAM'); if (w) skins.add(rec.ref(w.data.readUInt32LE(0)));
        return;
      }
      if (rec.type === 'LVLI') {
        for (const e of fs_('LVLO')) leveled.add(rec.ref(e.data.readUInt32LE(4)));
        return;
      }
      if (rec.type === 'OTFT') {
        const i = f('INAM');
        if (i) for (let o = 0; o + 4 <= i.data.length; o += 4) outfits.add(rec.ref(i.data.readUInt32LE(o)));
        return;
      }
      if (rec.type === 'COBJ') {
        if (rec.deleted) { cobjMap.delete(rec.key); return; }
        const c = f('CNAM'); const b = f('BNAM');
        if (c) {
          const n1 = f('NAM1');
          cobjMap.set(rec.key, {
            plugin: name, edid, key: rec.key,
            out: rec.ref(c.data.readUInt32LE(0)),
            bench: b ? rec.ref(b.data.readUInt32LE(0)) : null,
            count: n1 ? n1.data.readUInt16LE(0) : 1,
            items: fs_('CNTO').map((x) => ({ item: rec.ref(x.data.readUInt32LE(0)), count: x.data.readInt32LE(4) })),
            conds: fs_('CTDA').map((x) => decodeCtda(x.data, rec.ref))
          });
        }
        return;
      }
      if (rec.type === 'ARMO') {
        if (rec.deleted) { armors.delete(rec.key); return; }
        const prev = armors.get(rec.key);
        const a = { key: rec.key, origin: rec.key.split('|')[0], plugin: name, edid, recFlags: rec.flags };
        const full = f('FULL');
        a.name = full ? (hdr.localized ? null : zstring(full.data)) : null;
        const bod2 = f('BOD2'); const bodt = f('BODT');
        if (bod2) { a.slots = bod2.data.readUInt32LE(0); a.armorType = bod2.data.readUInt32LE(4); a.bodyFlags = 0; }
        else if (bodt) { a.slots = bodt.data.readUInt32LE(0); a.bodyFlags = bodt.data.readUInt8(4); a.armorType = bodt.data.length >= 12 ? bodt.data.readUInt32LE(8) : null; }
        const k = f('KWDA');
        a.kw = [];
        if (k) for (let o = 0; o + 4 <= k.data.length; o += 4) a.kw.push(rec.ref(k.data.readUInt32LE(o)));
        const d = f('DATA'); if (d) { a.value = d.data.readInt32LE(0); a.weight = d.data.readFloatLE(4); }
        const dn = f('DNAM'); a.rating = dn ? dn.data.readInt32LE(0) / 100 : 0;
        a.enchanted = Boolean(f('EITM'));
        const t = f('TNAM'); a.template = t ? rec.ref(t.data.readUInt32LE(0)) : null;
        const r = f('RNAM'); a.race = r ? rec.ref(r.data.readUInt32LE(0)) : null;
        a.addons = fs_('MODL').map((m) => rec.ref(m.data.readUInt32LE(0)));
        if (prev && !a.name && prev.name) a.name = prev.name;
        armors.set(rec.key, a);
      }
    });
    plugins.push({ name, masters: header.masters, light: header.light });
  }
  for (const a of armors.values()) a.kwEdids = a.kw.map((k) => keywords.get(k) || k);
  const cobjs = [...cobjMap.values()];
  return { order, plugins, armors, cobjs, skins, keywords, kwByEdid, leveled, outfits, misc, VANILLA };
}

module.exports = { scan, VANILLA, CLIENT_MODS, REPO, locate };
