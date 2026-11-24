/**
 * gear-gate-service.js — gear above a character's tier comes off
 *
 * Every worn armor piece and held weapon has a skill and a material tier
 * (core/gear-tiers.js, data/gear-tiers.json). A character can only use it
 * with that skill at the item's tier or higher; anything else is unequipped
 * and the player is told why. Runs with the skills module.
 */

'use strict';

const gearTiers = require('./core/gear-tiers');
const skills = require('./core/skills');
const { actorRef, baseRef } = require('./core/papyrus');

const TICK_MS = 1500;
const NOTICE_COOLDOWN_MS = 10000;

const SKILL_LABEL = Object.freeze({
  heavy_armor: 'Heavy Armor',
  light_armor: 'Light Armor',
  one_handed: 'One-Handed',
  two_handed: 'Two-Handed',
  archery: 'Archery'
});

let _deps = null;
let _timer = null;
/** actorId -> numChanges of the equipment last checked */
const _seen = new Map();
/** `${actorId}:${baseId}` -> last notice time */
const _noticed = new Map();

function configure(overrides = {}) {
  _deps = {
    mp: () => (typeof mp !== 'undefined' ? mp : null),
    listActive: () => require('./commands').listActiveActorIds(),
    characterOf: (actorId) => require('./commands').getActiveCharacterData(actorId),
    skillLevel: (characterId, skill) => require('./skills-service').skillLevel(characterId, skill),
    notify: (actorId, text) => require('./commands').sendNotification(actorId, text),
    unequip: (actorId, baseId) => {
      mp.callPapyrusFunction('method', 'Actor', 'UnequipItem', actorRef(actorId), [baseRef(baseId), false, true]);
    },
    now: () => Date.now(),
    logger: console,
    ...overrides
  };
  return _deps;
}

function deps() {
  return _deps || configure();
}

function wornEntries(actorId) {
  const api = deps().mp();
  let eq = null;
  try { eq = api && api.get(actorId, 'equipment'); } catch { eq = null; }
  const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
  return { changes: eq && Number.isFinite(eq.numChanges) ? eq.numChanges : null, worn: entries.filter((e) => e && (e.worn || e.wornLeft) && Number.isInteger(e.baseId)) };
}

function descOf(baseId) {
  const api = deps().mp();
  try { return api.getDescFromId(baseId >>> 0); } catch { return null; }
}

function message(item, check) {
  const label = SKILL_LABEL[check.skill] || check.skill;
  if (!check.have) return `You cannot use this: it needs the ${label} skill at ${check.required}.`;
  return `You cannot use this yet: it needs ${label} ${check.required} (you are ${check.have}).`;
}

/** Checks one actor; returns the base ids it took off. */
async function checkActor(actorId, { force = false } = {}) {
  const d = deps();
  const character = d.characterOf(actorId);
  if (!character || !character.characterId) return [];
  const { changes, worn } = wornEntries(actorId);
  if (!force && changes !== null && _seen.get(actorId) === changes) return [];
  _seen.set(actorId, changes);

  const removed = [];
  const levels = new Map();
  const levelOf = async (skill) => {
    if (!levels.has(skill)) levels.set(skill, Number(await d.skillLevel(character.characterId, skill)) || 0);
    return levels.get(skill);
  };
  for (const e of worn) {
    const entry = gearTiers.lookup(descOf(e.baseId));
    if (!entry) continue;
    const level = await levelOf(entry.skill);
    const check = gearTiers.canUse(entry, () => level, skills.tierIndex);
    if (check.ok) continue;
    try {
      d.unequip(actorId, e.baseId >>> 0);
      removed.push(e.baseId >>> 0);
    } catch (err) {
      d.logger.error(`[gear-gate] Could not unequip ${(e.baseId >>> 0).toString(16)} from ${actorId.toString(16)}:`, err.message);
      continue;
    }
    const key = `${actorId}:${e.baseId >>> 0}`;
    const last = _noticed.get(key);
    if (last === undefined || d.now() - last >= NOTICE_COOLDOWN_MS) {
      _noticed.set(key, d.now());
      try { d.notify(actorId, message(e, check)); } catch { /* left */ }
    }
  }
  if (removed.length) _seen.delete(actorId);
  return removed;
}

async function tick() {
  for (const actorId of deps().listActive()) {
    try { await checkActor(actorId); } catch (err) { deps().logger.error('[gear-gate] check failed:', err.message); }
  }
  const active = new Set(deps().listActive());
  for (const id of _seen.keys()) if (!active.has(id)) _seen.delete(id);
}

function initialize(overrides = {}) {
  configure(overrides);
  const n = gearTiers.load();
  deps().logger.log(`[gear-gate] ${n} armor and weapon tiers loaded.`);
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
}

/** Skill levels changed (level up, staff edit): check again even without an equipment change. */
function recheck(actorId) {
  _seen.delete(actorId);
}

function shutdown() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _seen.clear();
  _noticed.clear();
}

module.exports = { initialize, shutdown, checkActor, recheck, tick, configure, TICK_MS };
