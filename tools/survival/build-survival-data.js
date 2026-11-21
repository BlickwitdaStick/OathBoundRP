#!/usr/bin/env node
/**
 * Reads what server-side survival needs from the game's own plugins and writes
 * skymp/gamemode/data/survival-data.json:
 *
 * - regions: outlines of the vanilla map regions Survival Mode uses to decide
 *   warm / cool / freezing (REGN records: worldspace + polygons), from
 *   Skyrim.esm, Update.esm, Dawnguard.esm and Dragonborn.esm;
 * - foods: what each food restores, from Survival Mode's own edits to the
 *   vanilla foods (its effects Survival_FoodRestoreHunger*, FoodRestoreCold,
 *   FoodFortifyWarmth, which live in Update.esm);
 * - coldInteriorCells: interiors Survival counts as cold;
 * - keywords: Survival_ArmorWarm / Survival_ArmorCold / Survival_BodyAndHead.
 *
 * FormIDs are written as the server sees them. The five masters load as
 * 00 Skyrim, 01 Update, 02 Dawnguard, 03 HearthFires, 04 Dragonborn on this
 * server (and in Survival Mode's own master list), so plugin-local ids map to
 * those indexes.
 *
 * Usage: node tools/survival/build-survival-data.js [SkyrimData]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = process.argv[2] || process.env.SKYRIM_DATA || 'E:\\SkyrimRP\\Skyrim Special Edition\\Data';
const OUT = path.resolve(__dirname, '..', '..', 'skymp', 'gamemode', 'data', 'survival-data.json');
const LOAD = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
const SURVIVAL = 'ccQDRSSE001-SurvivalMode.esl';

/** Regions referenced by Survival_RegionInfoSpell's conditions (see core/survival-needs.js AREA_RULES). */
const REGIONS = [
  'WeatherSnow', 'WeatherCoast', 'WeatherCoastFog', 'WeatherMountains', 'WeatherMountainsNoPrecip',
  'WeatherTundra', 'WeatherTundraMarsh', 'WeatherReach', 'WeatherPineForest', 'WeatherFallForest',
  'WeatherWinterhold', 'WeatherSkuldafn', 'WeatherWhiterun', 'WeatherWindhelm', 'WeatherSolitude',
  'WeatherMarkarth', 'WeatherRiften', 'BlackreachRegion',
  'AudioExtFallForestDLC1FortDawnguard', 'DLC01VampCastleStorm', 'DLC01WeatherCanyon', 'DLC01WeatherIce',
  'DLC01WeatherPlayground', 'DLC1FalmerValleyBorder', 'DLC01WeatherGrove',
  'WeatherRavenRock01', 'WeatherDLC2SolstheimSnow', 'WeatherDLC2SolstheimMtns', 'WeatherDLC2SolstheimSnowHeavy',
  'WeatherVolcanicAsh01', 'WeatherVolcanicAsh02',
  'SurvivalForelhost', 'SurvivalArcwindPoint'
];

const FOOD_EFFECTS = {
  Survival_FoodRestoreHungerVerySmall: 'hunger:verySmall',
  Survival_FoodRestoreHungerSmall: 'hunger:small',
  Survival_FoodRestoreHungerMedium: 'hunger:medium',
  Survival_FoodRestoreHungerLarge: 'hunger:large',
  Survival_FoodRestoreCold: 'cold',
  Survival_FoodFortifyWarmth: 'warmth'
};

// ── plugin reading ───────────────────────────────────────────────────────────

function readPlugin(name) {
  const buf = fs.readFileSync(path.join(DATA, name));
  const headSize = buf.readUInt32LE(4);
  const masters = fieldsOf(buf.subarray(24, 24 + headSize)).filter((f) => f.type === 'MAST').map((f) => zstr(f.data));
  const selfIndex = name === SURVIVAL ? 0xfe : LOAD.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  /** plugin-local FormID → id on the server */
  const toGlobal = (local) => {
    const hi = local >>> 24;
    const low = local & 0xffffff;
    if (hi < masters.length) {
      const idx = LOAD.findIndex((n) => n.toLowerCase() === masters[hi].toLowerCase());
      if (idx < 0) return null;
      return ((idx << 24) | low) >>> 0;
    }
    return selfIndex === 0xfe ? null : ((selfIndex << 24) | low) >>> 0;
  };
  return { name, buf, headSize, masters, toGlobal };
}

function zstr(d) {
  const end = d.indexOf(0);
  return d.toString('latin1', 0, end < 0 ? d.length : end);
}

function fieldsOf(data) {
  const out = [];
  let p = 0;
  let big = 0;
  while (p + 6 <= data.length) {
    const type = data.toString('latin1', p, p + 4);
    let size = data.readUInt16LE(p + 4);
    if (type === 'XXXX') { big = data.readUInt32LE(p + 6); p += 10; continue; }
    if (big) { size = big; big = 0; }
    out.push({ type, data: data.subarray(p + 6, p + 6 + size) });
    p += 6 + size;
  }
  return out;
}

/** Calls fn(record) for every record of `type` in top-level group `type`. */
function eachRecord(plugin, type, fn) {
  const { buf } = plugin;
  let off = 24 + plugin.headSize;
  while (off + 24 <= buf.length) {
    const size = buf.readUInt32LE(off + 4);
    const label = buf.toString('latin1', off + 8, off + 12);
    if (label === type) walk(off + 24, off + size);
    off += size;
  }
  function walk(o, end) {
    while (o < end) {
      const t = buf.toString('latin1', o, o + 4);
      const size = buf.readUInt32LE(o + 4);
      if (t === 'GRUP') { walk(o + 24, o + size); o += size; continue; }
      if (t === type) {
        const flags = buf.readUInt32LE(o + 8);
        const id = buf.readUInt32LE(o + 12);
        let data = buf.subarray(o + 24, o + 24 + size);
        if (flags & 0x40000) data = zlib.inflateSync(data.subarray(4));
        const fields = fieldsOf(data);
        const edid = fields.find((f) => f.type === 'EDID');
        fn({ id, edid: edid ? zstr(edid.data) : '', fields, deleted: Boolean(flags & 0x20) });
      }
      o += 24 + size;
    }
  }
}

// ── regions ──────────────────────────────────────────────────────────────────

function readRegions() {
  const want = new Set(REGIONS);
  const regions = {};
  for (const name of ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'Dragonborn.esm']) {
    const plugin = readPlugin(name);
    eachRecord(plugin, 'REGN', (r) => {
      if (!want.has(r.edid) || r.deleted) return;
      const wnam = r.fields.find((f) => f.type === 'WNAM');
      const areas = [];
      for (const f of r.fields) {
        if (f.type !== 'RPLD') continue;
        const pts = [];
        for (let i = 0; i + 8 <= f.data.length; i += 8) pts.push([Math.round(f.data.readFloatLE(i)), Math.round(f.data.readFloatLE(i + 4))]);
        if (pts.length >= 3) areas.push(pts);
      }
      regions[r.edid] = {
        id: `0x${plugin.toGlobal(r.id).toString(16)}`,
        worldspace: wnam ? `0x${plugin.toGlobal(wnam.data.readUInt32LE(0)).toString(16)}` : null,
        areas
      };
    });
  }
  const missing = REGIONS.filter((e) => !regions[e]);
  if (missing.length) throw new Error(`regions not found: ${missing.join(', ')}`);
  return regions;
}

// ── foods ────────────────────────────────────────────────────────────────────

function effectNames() {
  const names = new Map();
  const update = readPlugin('Update.esm');
  eachRecord(update, 'MGEF', (r) => {
    if (FOOD_EFFECTS[r.edid]) names.set(update.toGlobal(r.id), FOOD_EFFECTS[r.edid]);
  });
  if (names.size !== Object.keys(FOOD_EFFECTS).length) throw new Error('survival food effects not found in Update.esm');
  return names;
}

function readFoods() {
  const effects = effectNames();
  const foods = {};
  // Update.esm first, then Survival Mode's edits override.
  for (const name of ['Update.esm', SURVIVAL]) {
    const plugin = readPlugin(name);
    eachRecord(plugin, 'ALCH', (r) => {
      const id = plugin.toGlobal(r.id);
      // Survival Mode's own foods (the hot soups and stews) live in a light
      // plugin, whose ids depend on the load order: written as a FormDesc and
      // resolved by the server (mp.getIdFromDesc).
      const key = id !== null
        ? `0x${id.toString(16)}`
        : (name === SURVIVAL && (r.id >>> 24) === plugin.masters.length ? `${(r.id & 0xfff).toString(16)}:${SURVIVAL}` : null);
      if (key === null) return;
      const entry = { editorId: r.edid };
      for (const f of r.fields) {
        if (f.type !== 'EFID') continue;
        const kind = effects.get(plugin.toGlobal(f.data.readUInt32LE(0)));
        if (!kind) continue;
        if (kind.startsWith('hunger:')) entry.hunger = kind.slice(7);
        else entry[kind] = true;
      }
      if (entry.hunger || entry.cold || entry.warmth) foods[key] = entry;
    });
  }
  return foods;
}

// ── lists and keywords ───────────────────────────────────────────────────────

function readSurvivalLists() {
  const plugin = readPlugin(SURVIVAL);
  const lists = {};
  eachRecord(plugin, 'FLST', (r) => {
    lists[r.edid] = r.fields.filter((f) => f.type === 'LNAM')
      .map((f) => plugin.toGlobal(f.data.readUInt32LE(0)))
      .filter((id) => id !== null)
      .map((id) => `0x${id.toString(16)}`);
  });
  return lists;
}

function readKeywords() {
  const update = readPlugin('Update.esm');
  const out = {};
  const want = { Survival_ArmorWarm: 'armorWarm', Survival_ArmorCold: 'armorCold', Survival_BodyAndHead: 'bodyAndHead' };
  eachRecord(update, 'KYWD', (r) => {
    if (want[r.edid]) out[want[r.edid]] = `0x${update.toGlobal(r.id).toString(16)}`;
  });
  return out;
}

function main() {
  const lists = readSurvivalLists();
  const data = {
    generatedBy: 'tools/survival/build-survival-data.js',
    source: [...LOAD, SURVIVAL],
    regions: readRegions(),
    foods: readFoods(),
    rawMeat: lists.Survival_FoodRawMeat || [],
    coldInteriorCells: lists.Survival_ColdInteriorCells || [],
    keywords: readKeywords()
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
  const nAreas = Object.values(data.regions).reduce((n, r) => n + r.areas.length, 0);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(data.regions).length} regions (${nAreas} areas), ` +
    `${Object.keys(data.foods).length} foods, ${data.coldInteriorCells.length} cold interiors, keywords ${JSON.stringify(data.keywords)}`);
}

main();
