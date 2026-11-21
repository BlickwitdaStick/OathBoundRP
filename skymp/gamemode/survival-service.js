/**
 * survival-service.js
 *
 * Server-side survival: hunger, exhaustion and cold for every online
 * character, saved in `character_needs` (migration-v35). Rules and numbers
 * are in core/survival-needs.js.
 *
 * - Time: needs change with the server's game clock (environment-service),
 *   only while the character is online.
 * - Hunger: eating (SkyMP's onEatItem) restores it by Survival Mode's meal
 *   sizes (data/survival-data.json, read from the game's own plugins). Foods
 *   it does not list restore nothing.
 * - Exhaustion: press E on a bed or bedroll to rest; it drops while you stay
 *   next to it and stops when you walk away.
 * - Cold: from where you are on the vanilla map (Survival Mode's warm / cool /
 *   freezing regions and heights), indoors or out, and what you wear
 *   (Survival_ArmorWarm / Survival_ArmorCold), a torch, and hot meals.
 *
 * No penalties yet (owner, 2026-11-20): players see their needs with /needs
 * and get a message when one changes stage. Nothing else happens.
 *
 * Unverified in game: the shape of mp.get(actor, 'equipment') (read
 * defensively; without it, clothing simply gives no warmth) and that
 * onEatItem fires for every food a player eats.
 */

'use strict';

const needsRules = require('./core/survival-needs');
const activationEvents = require('./core/activation-events');
const { parseFormId } = require('./core/interaction-targets');

const MODULE_ID = 'survival';
const ACTIVATION_SUBSCRIBER = 'survival-rest';
const TICK_MS = 10000;
/** One tick never moves more than this many game hours (server stalls, clock jumps). */
const MAX_HOURS_PER_TICK = 1;
/** Without the environment clock: Skyrim's default timescale. */
const FALLBACK_TIMESCALE = 20;
/** Write to the database at least this often per character, even without a stage change. */
const SAVE_EVERY_MS = 60000;
/** Resting ends when you are farther than this from the bed (~3 m). */
const REST_RANGE = 200;

let _deps = null;
let _data = null;
let _regions = null;
let _foods = null;            // Map<number baseId, food>
let _coldInteriors = null;    // Set<number>
let _keywords = null;         // { warm, cold, bodyAndHead } numeric ids
/** actorId → { characterId, needs, lastHours, resting, warmUntil, area, savedAt } */
const _online = new Map();
const _placeCache = new Map(); // cellOrWorld id → { interior }
const _armorCache = new Map(); // baseId → { type, kind, bodyOrHead }
let _timer = null;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

function _defaultDeps() {
  return {
    db: require('./database'),
    commands: require('./commands'),
    mp: typeof mp === 'undefined' ? null : mp,
    data: require('./data/survival-data.json'),
    gameHours: () => {
      try {
        const env = require('./environment-service');
        const t = env.getWorldTime();
        if (t && Number.isFinite(t.gameDaysPassed)) return t.gameDaysPassed * 24;
      } catch { /* environment module off */ }
      return (Date.now() / 3600000) * FALLBACK_TIMESCALE;
    },
    isStaff: (actorId) => {
      try { return Boolean(require('./admin-service').getRole(actorId)); } catch { return false; }
    },
    now: () => Date.now(),
    logger: console
  };
}

function configure(overrides = {}) {
  _deps = { ...(_deps || _defaultDeps()), ...overrides };
  _data = null;
  return _deps;
}

function deps() {
  return _deps || configure();
}

function _num(v) {
  const n = typeof v === 'string' ? Number.parseInt(v, v.startsWith('0x') ? 16 : 10) : Number(v);
  return Number.isFinite(n) ? n >>> 0 : null;
}

/** Turns data/survival-data.json into lookups. Light-plugin foods are FormDescs resolved here. */
function loadData() {
  if (_data) return;
  const d = deps();
  _data = d.data;
  _regions = needsRules.prepareRegions(_data.regions);
  _foods = new Map();
  for (const [key, food] of Object.entries(_data.foods || {})) {
    let id = null;
    if (key.includes(':')) {
      try { id = d.mp && typeof d.mp.getIdFromDesc === 'function' ? d.mp.getIdFromDesc(key) : null; } catch { id = null; }
    } else {
      id = _num(key);
    }
    if (Number.isInteger(id)) _foods.set(id >>> 0, food);
  }
  _coldInteriors = new Set((_data.coldInteriorCells || []).map(_num));
  const k = _data.keywords || {};
  _keywords = { warm: _num(k.armorWarm), cold: _num(k.armorCold), bodyAndHead: _num(k.bodyAndHead) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the world
// ─────────────────────────────────────────────────────────────────────────────

function _lookup(id) {
  const api = deps().mp;
  if (!api || typeof api.lookupEspmRecordById !== 'function') return null;
  try {
    const r = api.lookupEspmRecordById(id);
    return r && r.record ? r : null;
  } catch {
    return null;
  }
}

function _bytes(data) {
  if (!data) return null;
  if (Array.isArray(data) || data instanceof Uint8Array) return Uint8Array.from(data);
  if (typeof data === 'string') { try { return Uint8Array.from(Buffer.from(data, 'base64')); } catch { return null; } }
  if (typeof data === 'object' && Array.isArray(data.data)) return Uint8Array.from(data.data);
  return null;
}

/** Keyword ids (global) of a base record, from its KWDA field. */
function _keywordsOf(lookup) {
  const fields = Array.isArray(lookup.record.fields) ? lookup.record.fields : [];
  const kwda = fields.find((f) => f && f.type === 'KWDA');
  const bytes = kwda ? _bytes(kwda.data) : null;
  const out = new Set();
  if (!bytes) return out;
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    let id = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    if (typeof lookup.toGlobalRecordId === 'function') id = lookup.toGlobalRecordId(id) >>> 0;
    out.add(id);
  }
  return out;
}

/** { interior, coldInterior, worldspace, pos } for an actor, or null. */
function placeOf(actorId) {
  const api = deps().mp;
  let loc;
  try { loc = api.get(actorId, 'locationalData'); } catch { loc = null; }
  if (!loc || !Array.isArray(loc.pos) || typeof loc.cellOrWorldDesc !== 'string') return null;
  let id;
  try { id = api.getIdFromDesc(loc.cellOrWorldDesc) >>> 0; } catch { return null; }
  if (!_placeCache.has(id)) {
    const r = _lookup(id);
    _placeCache.set(id, { interior: r ? r.record.type === 'CELL' : false });
  }
  const { interior } = _placeCache.get(id);
  return { interior, coldInterior: interior && _coldInteriors.has(id), worldspace: id, pos: loc.pos };
}

function _armorInfo(baseId) {
  if (_armorCache.has(baseId)) return _armorCache.get(baseId);
  const r = _lookup(baseId);
  let info = { type: r ? r.record.type : null, kind: null, bodyOrHead: false };
  if (r && r.record.type === 'ARMO') {
    const kw = _keywordsOf(r);
    info = {
      type: 'ARMO',
      kind: kw.has(_keywords.warm) ? 'warm' : kw.has(_keywords.cold) ? 'cold' : 'normal',
      bodyOrHead: kw.has(_keywords.bodyAndHead)
    };
  }
  _armorCache.set(baseId, info);
  return info;
}

/** Worn armor pieces and whether a torch is held, from SkyMP's equipment property. */
function wornOf(actorId) {
  const api = deps().mp;
  let eq;
  try { eq = api.get(actorId, 'equipment'); } catch { eq = null; }
  const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
  const pieces = [];
  let torch = false;
  for (const e of entries) {
    if (!e || !(e.worn || e.wornLeft) || !Number.isInteger(e.baseId)) continue;
    const info = _armorInfo(e.baseId >>> 0);
    if (info.type === 'ARMO') pieces.push({ kind: info.kind, bodyOrHead: info.bodyOrHead });
    else if (info.type === 'LIGH') torch = true;
  }
  return { pieces, torch };
}

function _distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

async function _load(characterId) {
  const rows = await deps().db.query('SELECT hunger, exhaustion, cold FROM character_needs WHERE character_id = ?', [characterId]);
  if (!rows.length) return { hunger: 0, exhaustion: 0, cold: 0 };
  return { hunger: Number(rows[0].hunger) || 0, exhaustion: Number(rows[0].exhaustion) || 0, cold: Number(rows[0].cold) || 0 };
}

async function _save(s) {
  const { hunger, exhaustion, cold } = s.needs;
  await deps().db.query(
    `INSERT INTO character_needs (character_id, hunger, exhaustion, cold) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE hunger = VALUES(hunger), exhaustion = VALUES(exhaustion), cold = VALUES(cold)`,
    [s.characterId, hunger, exhaustion, cold]
  );
  s.savedAt = deps().now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

function _notify(actorId, text) {
  try { deps().commands.sendNotification(actorId, text); } catch { /* player gone */ }
}

/** Tells the player about every need whose stage changed. @returns {boolean} any changed */
function _announce(actorId, before, after) {
  let changed = false;
  for (const need of ['hunger', 'exhaustion', 'cold']) {
    const a = needsRules.stageOf(need, before[need]);
    const b = needsRules.stageOf(need, after[need]);
    if (a !== b) {
      changed = true;
      _notify(actorId, needsRules.describe(need, after[need]).message);
    }
  }
  return changed;
}

function summary(s) {
  const line = (need, label) => {
    const d = needsRules.describe(need, s.needs[need]);
    return `${label}: ${d.name} (${Math.round(s.needs[need])}/${needsRules.NEEDS[need].max})`;
  };
  const where = needsRules.AREAS[s.area] ? needsRules.AREAS[s.area].label : 'somewhere';
  const rest = s.resting ? ' · resting' : '';
  return `${line('hunger', 'Hunger')} · ${line('exhaustion', 'Exhaustion')} · ${line('cold', 'Cold')} · You are in ${where}${rest}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle per character
// ─────────────────────────────────────────────────────────────────────────────

async function onLogin(actorId, characterId) {
  loadData();
  const needs = await _load(characterId);
  _online.set(actorId, {
    characterId, needs, lastHours: deps().gameHours(), resting: null, warmUntil: 0, area: 'temperate', savedAt: deps().now()
  });
}

async function onDisconnect(actorId) {
  const s = _online.get(actorId);
  _online.delete(actorId);
  if (s) {
    try { await _save(s); } catch (err) { deps().logger.error(`[survival] save at logout failed for ${s.characterId}: ${err.message}`); }
  }
}

/** Advances one character to the current game time. */
async function update(actorId) {
  const s = _online.get(actorId);
  if (!s) return null;
  const nowHours = deps().gameHours();
  const hours = Math.min(MAX_HOURS_PER_TICK, Math.max(0, nowHours - s.lastHours));
  s.lastHours = nowHours;

  const place = placeOf(actorId);
  if (place) s.area = needsRules.areaAt(_regions, place);
  if (s.resting && place && _distance(place.pos, s.resting.pos) > REST_RANGE) {
    s.resting = null;
    _notify(actorId, 'You get up.');
  }
  const worn = wornOf(actorId);
  const warmth = needsRules.warmthOf(worn.pieces, { torch: worn.torch, hotMeal: nowHours < s.warmUntil });

  const before = s.needs;
  s.needs = needsRules.advance(before, hours, { area: s.area, warmth, resting: s.resting });
  const stageChanged = _announce(actorId, before, s.needs);
  if (s.resting && s.needs.exhaustion <= s.resting.floor && before.exhaustion > s.resting.floor) {
    _notify(actorId, s.resting.floor > 0 ? 'You have rested as well as a bedroll allows.' : 'You are fully rested.');
  }
  if (stageChanged || deps().now() - s.savedAt >= SAVE_EVERY_MS) await _save(s);
  return s;
}

async function tick() {
  for (const actorId of [..._online.keys()]) {
    try { await update(actorId); } catch (err) { deps().logger.error(`[survival] update failed for ${actorId.toString(16)}: ${err.message}`); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Game events
// ─────────────────────────────────────────────────────────────────────────────

/** mp.onEatItem(actorId, baseId) */
function handleEat(actorId, baseId) {
  const s = _online.get(actorId);
  if (!s) return;
  loadData();
  const result = needsRules.eat(s.needs, _foods.get(baseId >>> 0) || null);
  if (!result) return;
  const before = s.needs;
  s.needs = result.needs;
  if (result.warmthHours > 0) {
    s.warmUntil = deps().gameHours() + result.warmthHours;
    _notify(actorId, 'The hot meal warms you.');
  }
  if (_announce(actorId, before, s.needs)) {
    _save(s).catch((err) => deps().logger.error(`[survival] save after eating failed: ${err.message}`));
  }
}

/** Bed or bedroll? From the base record: a FURN whose editor id names a bed. */
function bedKind(targetId) {
  const api = deps().mp;
  let baseDesc;
  try { baseDesc = api.get(targetId, 'baseDesc'); } catch { baseDesc = null; }
  if (typeof baseDesc !== 'string') return null;
  let baseId;
  try { baseId = api.getIdFromDesc(baseDesc); } catch { return null; }
  const r = _lookup(baseId);
  if (!r || r.record.type !== 'FURN') return null;
  const editorId = String(r.record.editorId || '');
  if (/bedroll/i.test(editorId)) return 'bedroll';
  if (/bed/i.test(editorId)) return 'bed';
  return null;
}

/** activation-events subscriber: starts resting on a bed. Never blocks the activation. */
function handleActivation(targetId, casterId) {
  const target = parseFormId(targetId);
  const caster = parseFormId(casterId);
  const s = caster === null ? null : _online.get(caster);
  if (!s || target === null) return undefined;
  const kind = bedKind(target);
  if (!kind) return undefined;
  const place = placeOf(caster);
  if (!place) return undefined;
  s.resting = { pos: place.pos, floor: kind === 'bedroll' ? needsRules.BEDROLL_REST_FLOOR : 0 };
  _notify(caster, kind === 'bedroll'
    ? 'You lie down on the bedroll to rest. Stay here; walk away to get up.'
    : 'You lie down to rest. Stay here; walk away to get up.');
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function handleNeedsCommand(actorId) {
  const s = await update(actorId);
  _notify(actorId, s ? `[Needs] ${summary(s)}` : '[Needs] Not available right now.');
}

/** /setneed <player#> <hunger|exhaustion|cold> <value> */
async function handleSetNeedCommand(actorId, args) {
  if (!deps().isStaff(actorId)) return _notify(actorId, 'Staff only.');
  const [target, need, raw] = String(args || '').trim().split(/\s+/);
  const targetId = /^0x[0-9a-f]+$/i.test(target || '') ? Number.parseInt(target.slice(2), 16) : null;
  const s = targetId === null ? null : _online.get(targetId);
  if (!s) return _notify(actorId, 'Usage: /setneed <player#> <hunger|exhaustion|cold> <value> (player online)');
  if (!needsRules.NEEDS[need]) return _notify(actorId, 'Need must be hunger, exhaustion or cold.');
  const value = Number(raw);
  const max = needsRules.NEEDS[need].max;
  if (!Number.isFinite(value) || value < 0 || value > max) return _notify(actorId, `Value must be 0-${max}.`);
  const before = s.needs;
  s.needs = { ...before, [need]: value };
  _announce(targetId, before, s.needs);
  await _save(s);
  _notify(actorId, `[Needs] ${need} set to ${value}: ${needsRules.describe(need, value).name}.`);
}

function commandDefs() {
  const wrap = (fn) => (actorId, args) => fn(actorId, args).catch((err) => {
    deps().logger.error('[survival] command failed:', err.message);
    _notify(actorId, 'Could not complete that. Check the server log.');
  });
  return [
    { name: '/needs', handler: wrap(handleNeedsCommand), description: 'Show your hunger, exhaustion and cold', usage: '/needs' },
    { name: '/setneed', handler: wrap(handleSetNeedCommand), description: '[Staff] Set a player\'s hunger, exhaustion or cold', usage: '/setneed <player#> <hunger|exhaustion|cold> <value>' }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function initialize(overrides = {}) {
  configure(overrides);
  loadData();
  const d = deps();
  activationEvents.subscribe(ACTIVATION_SUBSCRIBER, handleActivation);
  if (d.mp) {
    if (typeof d.mp.onEatItem === 'function') {
      d.logger.warn('[survival] mp.onEatItem already had a handler; survival chains after it.');
      const previous = d.mp.onEatItem;
      d.mp.onEatItem = (...a) => { const r = previous(...a); handleEat(a[0], a[1]); return r; };
    } else {
      d.mp.onEatItem = (actorId, baseId) => { handleEat(actorId, baseId); };
    }
  }
  if (!_timer) {
    _timer = setInterval(() => { tick().catch((err) => d.logger.error('[survival] tick failed:', err.message)); }, TICK_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
  }
  d.logger.log(`[survival] ${_regions.length} map areas, ${_foods.size} foods, ${_coldInteriors.size} cold interiors loaded. No penalties.`);
}

function shutdown() {
  activationEvents.unsubscribe(ACTIVATION_SUBSCRIBER);
  if (_timer) clearInterval(_timer);
  _timer = null;
}

function isOnline(actorId) {
  return _online.has(actorId);
}

function healthCheck() {
  return Boolean(_regions);
}

function _resetForTest() {
  _online.clear();
  _placeCache.clear();
  _armorCache.clear();
  _data = null;
  _deps = null;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  MODULE_ID,
  configure,
  initialize,
  shutdown,
  healthCheck,
  commandDefs,
  onLogin,
  onDisconnect,
  update,
  tick,
  handleEat,
  handleActivation,
  bedKind,
  placeOf,
  wornOf,
  summary,
  isOnline,
  _resetForTest
};
