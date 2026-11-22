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
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'skymp', 'gamemode', 'data', 'survival-data.json');
/** Hosted mods (Gourmet etc.): their foods count too, in the game's load order. */
const CLIENT_MODS = path.join(REPO, 'skymp', 'client-mods');
const CLIENT_MANIFEST = path.join(REPO, 'apps', 'game-api', 'client-mods-manifest.json');
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

/**
 * Thirst (ours; Survival Mode has none). Brewer keeps drinks apart from food,
 * so every ALCH whose editor id names a drink restores thirst. Vanilla drinks
 * carry no keyword of their own, so the name is the only signal that covers
 * vanilla, Gourmet, Brewer and Wares of Tamriel alike.
 */
const NOT_A_DRINK = /Potion|Poison|Skooma|WaterBreathing|Waterbreathing|WaterWalking|Salt|Sleeping|Ingredient|Bread|Cheese|Dummy|^DA[0-9]/;
const DRINKS = [
  ['large', /Water|Milk|Juice|Tea(?![a-z])|Cider|Lemonade|Coffee/],
  ['medium', /Mead|Ale(?![a-z])|Beer|Wine|Lager|Stout|Porter/],
  ['small', /Whiske?y|Gin(?![a-z])|Vodka|Rum(?![a-z])|Brandy|Sujamma|Flin(?![a-z])|Shein|Mazte|Matze|Liquor|Spirits?(?![a-z])|Moonshine/],
  ['small', /Soup|Stew|Broth/]
];

function thirstOf(editorId) {
  if (!editorId || NOT_A_DRINK.test(editorId)) return null;
  for (const [size, re] of DRINKS) if (re.test(editorId)) return size;
  return null;
}

// ── plugin reading ───────────────────────────────────────────────────────────

/** A plugin file: hosted mods first, then the game's Data folder. */
function pluginPath(name) {
  const hosted = path.join(CLIENT_MODS, name);
  return fs.existsSync(hosted) ? hosted : path.join(DATA, name);
}

/** Plugin names spelled as in the server's load order (masters are often lower-cased). */
const SERVER_SETTINGS = path.join(REPO, 'skymp', 'server', 'server-settings.json');
const _canonical = new Map((() => {
  try { return JSON.parse(fs.readFileSync(SERVER_SETTINGS, 'utf8')).loadOrder || []; } catch { return []; }
})().map((n) => [String(n).toLowerCase(), String(n)]));
const canonical = (name) => _canonical.get(String(name).toLowerCase()) || name;

const _lightCache = new Map();
function isLight(name) {
  const key = name.toLowerCase();
  if (!_lightCache.has(key)) {
    let light = /.esl$/i.test(name);
    try {
      const head = Buffer.alloc(12);
      const fd = fs.openSync(pluginPath(name), 'r');
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      light = light || Boolean(head.readUInt32LE(8) & 0x200);
    } catch { /* not found: treat as full */ }
    _lightCache.set(key, light);
  }
  return _lightCache.get(key);
}

function readPlugin(name) {
  const buf = fs.readFileSync(pluginPath(name));
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
  /**
   * plugin-local FormID → key for the server: "0x…" for the five base masters
   * (fixed indexes), else a FormDesc "id:Plugin.esp" the server resolves with
   * mp.getIdFromDesc (light plugins keep 12 bits of id, full ones 24).
   */
  const keyOf = (local) => {
    const id = toGlobal(local);
    if (id !== null) return `0x${id.toString(16)}`;
    const hi = local >>> 24;
    const owner = hi < masters.length ? masters[hi] : name;
    return `${(local & (isLight(owner) ? 0xfff : 0xffffff)).toString(16)}:${canonical(owner)}`;
  };
  return { name, buf, headSize, masters, toGlobal, keyOf };
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
  // Update.esm, then Survival Mode, then every hosted mod in the game's load
  // order (Gourmet's survival module gives its foods the same effects). Foods
  // in light or modded plugins are keyed by FormDesc (see keyOf). A later
  // plugin that edits a food WITHOUT survival effects (WACCF, for one) does
  // not erase it: the table keeps the last survival values it saw.
  const hosted = fs.existsSync(CLIENT_MANIFEST) ? (JSON.parse(fs.readFileSync(CLIENT_MANIFEST, 'utf8')).plugins || []) : [];
  // The base game first, for its drinks (ale, mead, milk): they have no
  // survival effects, only a thirst value from their name.
  for (const name of ['Skyrim.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm', 'Update.esm', SURVIVAL, ...hosted.filter((p) => fs.existsSync(path.join(CLIENT_MODS, p)))]) {
    const plugin = readPlugin(name);
    eachRecord(plugin, 'ALCH', (r) => {
      const key = plugin.keyOf(r.id);
      const entry = { editorId: r.edid };
      for (const f of r.fields) {
        if (f.type !== 'EFID') continue;
        const kind = effects.get(plugin.toGlobal(f.data.readUInt32LE(0)));
        if (!kind) continue;
        if (kind.startsWith('hunger:')) entry.hunger = kind.slice(7);
        else entry[kind] = true;
      }
      const thirst = thirstOf(r.edid);
      if (thirst) entry.thirst = thirst;
      if (entry.hunger || entry.cold || entry.warmth || entry.thirst) foods[key] = { ...(foods[key] || {}), ...entry };
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
