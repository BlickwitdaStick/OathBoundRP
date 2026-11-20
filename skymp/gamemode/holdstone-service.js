/**
 * holdstone-service.js
 *
 * Holdstones, hold rank ladders, parcels and door/container locks
 * (migration-v33-holdstones-parcels.sql, docs/gameplay/HOLDSTONES_AND_PARCELS.md).
 *
 * - Holdstone: one world object per hold. Activating it (E) opens the hold
 *   menu through the Interaction Framework (it is a physical anchor, so the
 *   `interaction-prompt` subscriber turns the activation into the menu).
 * - Ranks: an ordered ladder per hold (`hold_ranks.position`); leader ranks
 *   (`is_leader`) set ranks below their own and manage parcels.
 * - Parcel: a set of doors and containers with an owner and a minimum rank.
 *   Locked parcel objects open only for the owner, members at or above the
 *   minimum rank in that hold, and staff. Everyone else reads "It's locked."
 *   and the activation is blocked (`core/activation-events.js`).
 * - Parceling tool: a leader/staff picks a parcel at the holdstone, then
 *   presses E on doors and containers to get "Add to parcel" / "Remove from
 *   parcel" — no commands needed. Staff commands remain as a fallback.
 *
 * All permission decisions live in `core/parcel-locks.js` (pure, tested).
 * This file loads the index, writes changes, and wires the game hooks.
 *
 * Load doors: a load door is two references (one per cell). When a door is
 * added, the service tries to read the other side from the reference's XTEL
 * record field. That side is stored as an exit (`locks = 0`): it is part of
 * the parcel but never blocks, so nobody gets locked inside. A leader can
 * flip any door with "Lock this side" / "Make this side an exit". Reading
 * XTEL from `mp.lookupEspmRecordById` is unverified in game — if it returns
 * nothing, staff simply add the inside door by hand with the tool.
 */

'use strict';

const database = require('./database');
const parcelLocks = require('./core/parcel-locks');
const activationEvents = require('./core/activation-events');
const interactionRegistry = require('./core/interaction-registry');
const physicalAnchorRegistry = require('./core/physical-anchor-registry');
const { parseFormId } = require('./core/interaction-targets');
const espm = require('./core/espm');

const MODULE_ID = 'holdstones';
const ACTIVATION_SUBSCRIBER = 'holdstones';
const LOCKED_MESSAGE = "It's locked.";
/** About 5 m: stand at the door or chest you are assigning. */
const PARCEL_TOOL_RANGE = 350;
const HOLDSTONE_RANGE = 350;
const NAME_MAX = 64;
const RANK_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const FORM_DESC_PATTERN = /^[0-9a-f]{1,8}:[^\s:]+\.(esm|esp|esl)$/i;

let _index = parcelLocks.EMPTY_INDEX;
/** actorId → { parcelId } | { placeHoldId } */
const _tools = new Map();
let _deps = null;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

function _mp() {
  return typeof mp === 'undefined' ? null : mp;
}

function _defaultDeps() {
  const commands = require('./commands');
  return {
    db: database,
    commands,
    isStaff: (actorId) => {
      try { return Boolean(require('./admin-service').getRole(actorId)); } catch { return false; }
    },
    sendModal: () => {},
    openInteractionMenu: () => {},
    logger: console
  };
}

function configure(overrides = {}) {
  _deps = { ...(_deps || _defaultDeps()), ...overrides };
  return _deps;
}

function deps() {
  return _deps || configure();
}

function getIndex() {
  return _index;
}

function _setIndexForTest(index) {
  _index = index;
}

// ─────────────────────────────────────────────────────────────────────────────
// FormDesc helpers (objects are never keyed on numeric FormIDs in the DB)
// ─────────────────────────────────────────────────────────────────────────────

function descOf(formId) {
  const api = _mp();
  if (!api || typeof api.getDescFromId !== 'function') return null;
  try {
    const desc = api.getDescFromId(formId);
    return typeof desc === 'string' && desc.includes(':') ? desc : null;
  } catch {
    return null;
  }
}

function idOfDesc(desc) {
  const api = _mp();
  if (!api || typeof api.getIdFromDesc !== 'function') return null;
  return api.getIdFromDesc(desc);
}

function normalizeDesc(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^0x/i, '');
  if (!FORM_DESC_PATTERN.test(clean)) return null;
  const [hex, plugin] = clean.split(':');
  return `${hex.toLowerCase().replace(/^0+(?=.)/, '')}:${plugin}`;
}

/** 'door' | 'container' | null, from the base record type (DOOR / CONT). */
function detectKind(formId) {
  const api = _mp();
  if (!api || typeof api.get !== 'function') return null;
  try {
    const baseDesc = api.get(formId, 'baseDesc');
    const baseId = typeof baseDesc === 'string' ? api.getIdFromDesc(baseDesc) : null;
    const type = baseId ? espm.lookup(baseId).type : null;
    if (type === 'DOOR') return 'door';
    if (type === 'CONT') return 'container';
  } catch {
    // fall through
  }
  return null;
}

function _bytes(data) {
  if (!data) return null;
  if (Array.isArray(data) || data instanceof Uint8Array) return data;
  if (typeof data === 'string') {
    try { return Buffer.from(data, 'base64'); } catch { return null; }
  }
  if (typeof data === 'object' && Array.isArray(data.data)) return data.data;
  return null;
}

/**
 * Other side of a load door, from the reference's XTEL field (first 4 bytes =
 * destination door, plugin-local). Best effort: null when anything is unknown.
 * @returns {string|null} FormDesc
 */
function findTeleportPartner(formId) {
  const api = _mp();
  if (!api || typeof api.lookupEspmRecordById !== 'function') return null;
  try {
    const r = api.lookupEspmRecordById(formId);
    const fields = r && r.record && Array.isArray(r.record.fields) ? r.record.fields : [];
    const xtel = fields.find((f) => f && f.type === 'XTEL');
    const bytes = xtel ? _bytes(xtel.data) : null;
    if (!bytes || bytes.length < 4) return null;
    let local = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    if (!local) return null;
    if (typeof r.toGlobalRecordId === 'function') local = r.toGlobalRecordId(local);
    const desc = descOf(local);
    return desc && desc !== descOf(formId) ? desc : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Index loading
// ─────────────────────────────────────────────────────────────────────────────

async function reload() {
  const { db } = deps();
  const [holds, holdstones, ranks, members, parcels, objects] = await Promise.all([
    db.query('SELECT id, name FROM holds ORDER BY id'),
    db.query('SELECT hold_id, object_id FROM holdstones'),
    db.query('SELECT id, hold_id, rank_key, name, position, is_leader FROM hold_ranks'),
    db.query('SELECT hold_id, character_id, rank_id FROM hold_members'),
    db.query('SELECT id, hold_id, name, owner_character_id, min_rank_id, locked FROM parcels'),
    db.query('SELECT object_id, parcel_id, kind, locks, partner_object_id FROM parcel_objects')
  ]);
  _index = parcelLocks.buildIndex({ holds, holdstones, ranks, members, parcels, objects }, idOfDesc);
  try { await physicalAnchorRegistry.refresh(); } catch { /* anchors are optional */ }
  return _index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actors
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {{actorId:number, characterId:number|null, isStaff:boolean}} */
function actorOf(actorId) {
  const d = deps();
  const ch = d.commands.getActiveCharacterData(actorId);
  return { actorId, characterId: ch ? ch.characterId : null, isStaff: Boolean(d.isStaff(actorId)) };
}

async function characterByNumber(number) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const rows = await deps().db.query(
    "SELECT id, first_name, last_name, char_number FROM characters WHERE char_number = ? AND status = 'approved'",
    [n]
  );
  return rows.length ? { id: Number(rows[0].id), name: `${rows[0].first_name} ${rows[0].last_name}`, number: n } : null;
}

async function characterNames(ids) {
  const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
  if (unique.length === 0) return new Map();
  const rows = await deps().db.query(
    `SELECT id, first_name, last_name, char_number FROM characters WHERE id IN (${unique.map(() => '?').join(',')})`,
    unique
  );
  return new Map(rows.map((r) => [Number(r.id), {
    name: `${r.first_name} ${r.last_name}`,
    number: r.char_number == null ? null : Number(r.char_number)
  }]));
}

function _notifyCharacter(characterId, message) {
  const d = deps();
  if (typeof d.commands.getActiveActorByCharacterId !== 'function') return;
  const actorId = d.commands.getActiveActorByCharacterId(characterId);
  if (actorId) d.commands.sendNotification(actorId, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes. Each returns { ok, message } and reloads the index on success.
// Authorization is checked by the caller (interactions / commands) against
// the same `actor` object, so both paths enforce the same rules.
// ─────────────────────────────────────────────────────────────────────────────

const ok = (message, extra = {}) => ({ ok: true, message, ...extra });
const no = (message) => ({ ok: false, message });

function _holdName(holdId) {
  return _index.holds.get(holdId) || holdId;
}

function _validName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= NAME_MAX;
}

async function setHoldstone(holdId, objectDesc) {
  if (!_index.holds.has(holdId)) return no(`Unknown hold "${holdId}".`);
  const desc = normalizeDesc(objectDesc);
  if (!desc) return no('That object has no FormDesc (hex:Plugin.esm).');
  if (_index.objectsByDesc.has(desc)) return no('That object is part of a parcel; remove it first.');
  const { db } = deps();
  await db.query('DELETE FROM holdstones WHERE object_id = ? AND hold_id <> ?', [desc, holdId]);
  await db.query(
    'INSERT INTO holdstones (hold_id, object_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE object_id = VALUES(object_id)',
    [holdId, desc]
  );
  await reload();
  return ok(`${_holdName(holdId)} holdstone set to ${desc}.`);
}

async function clearHoldstone(holdId) {
  await deps().db.query('DELETE FROM holdstones WHERE hold_id = ?', [holdId]);
  await reload();
  return ok(`${_holdName(holdId)} has no holdstone now.`);
}

async function addRank(holdId, key, position, isLeader, name) {
  if (!_index.holds.has(holdId)) return no(`Unknown hold "${holdId}".`);
  const rankKey = String(key || '').toLowerCase();
  if (!RANK_KEY_PATTERN.test(rankKey)) return no('Rank key must be lowercase letters, digits or _ (e.g. "captain").');
  if (!Number.isSafeInteger(position) || position < 1 || position > 1000) return no('Position must be 1-1000.');
  if (!_validName(name)) return no(`Rank name must be 2-${NAME_MAX} characters.`);
  if (parcelLocks.ranksOf(_index, holdId).some((r) => r.position === position && r.key !== rankKey)) {
    return no(`Position ${position} is already used in ${_holdName(holdId)}.`);
  }
  await deps().db.query(
    `INSERT INTO hold_ranks (hold_id, rank_key, name, position, is_leader) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position), is_leader = VALUES(is_leader)`,
    [holdId, rankKey, name.trim(), position, isLeader ? 1 : 0]
  );
  await reload();
  return ok(`${_holdName(holdId)}: rank ${name.trim()} (${rankKey}) at position ${position}${isLeader ? ', leader' : ''}.`);
}

async function removeRank(holdId, key) {
  const rank = parcelLocks.findRank(_index, holdId, key);
  if (!rank) return no(`No rank "${key}" in ${_holdName(holdId)}.`);
  // Members holding it are removed by the FK cascade; parcels fall back to owner-only.
  await deps().db.query('DELETE FROM hold_ranks WHERE id = ?', [rank.id]);
  await reload();
  return ok(`${_holdName(holdId)}: rank ${rank.name} removed.`);
}

/**
 * @param {{characterId:number|null, isStaff:boolean}} actor
 * @param {string} holdId
 * @param {{id:number, name:string}} target character
 * @param {string|null} rankKey null / 'none' removes the membership
 */
async function setMemberRank(actor, holdId, target, rankKey) {
  if (!_index.holds.has(holdId)) return no(`Unknown hold "${holdId}".`);
  const removing = rankKey == null || String(rankKey).toLowerCase() === 'none';
  const rank = removing ? null : parcelLocks.findRank(_index, holdId, rankKey);
  if (!removing && !rank) {
    const keys = parcelLocks.ranksOf(_index, holdId).map((r) => r.key).join(', ');
    return no(`No rank "${rankKey}" in ${_holdName(holdId)}. Ranks: ${keys || 'none'}.`);
  }
  const verdict = parcelLocks.canAssignRank(_index, holdId, actor, target.id, rank);
  if (!verdict.ok) return no(verdict.message);

  const { db } = deps();
  if (removing) {
    await db.query('DELETE FROM hold_members WHERE hold_id = ? AND character_id = ?', [holdId, target.id]);
  } else {
    await db.query(
      `INSERT INTO hold_members (hold_id, character_id, rank_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE rank_id = VALUES(rank_id)`,
      [holdId, target.id, rank.id]
    );
  }
  await reload();
  const text = removing
    ? `${target.name} is no longer a member of ${_holdName(holdId)}.`
    : `${target.name} is now ${rank.name} of ${_holdName(holdId)}.`;
  _notifyCharacter(target.id, `[Hold] ${text}`);
  return ok(text);
}

async function createParcel(holdId, name, minRankKey = null) {
  if (!_index.holds.has(holdId)) return no(`Unknown hold "${holdId}".`);
  if (!_validName(name)) return no(`Parcel name must be 2-${NAME_MAX} characters.`);
  let minRank = null;
  if (minRankKey && String(minRankKey).toLowerCase() !== 'none') {
    minRank = parcelLocks.findRank(_index, holdId, minRankKey);
    if (!minRank) return no(`No rank "${minRankKey}" in ${_holdName(holdId)}.`);
  }
  if (parcelLocks.parcelsOf(_index, holdId).some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) {
    return no(`${_holdName(holdId)} already has a parcel named "${name.trim()}".`);
  }
  const result = await deps().db.query(
    'INSERT INTO parcels (hold_id, name, min_rank_id, locked) VALUES (?, ?, ?, 1)',
    [holdId, name.trim(), minRank ? minRank.id : null]
  );
  await reload();
  const id = result && result.insertId;
  return ok(`Parcel #${id} "${name.trim()}" created in ${_holdName(holdId)}${minRank ? ` (${minRank.name} and above)` : ' (owner and staff only)'}.`, { parcelId: id });
}

function _parcel(parcelId) {
  return _index.parcels.get(Number(parcelId)) || null;
}

async function renameParcel(parcelId, name) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  if (!_validName(name)) return no(`Parcel name must be 2-${NAME_MAX} characters.`);
  if (parcelLocks.parcelsOf(_index, parcel.holdId).some((p) => p.id !== parcel.id && p.name.toLowerCase() === name.trim().toLowerCase())) {
    return no(`${_holdName(parcel.holdId)} already has a parcel named "${name.trim()}".`);
  }
  await deps().db.query('UPDATE parcels SET name = ? WHERE id = ?', [name.trim(), parcel.id]);
  await reload();
  return ok(`Parcel #${parcel.id} renamed to "${name.trim()}".`);
}

/** @param {{id:number, name:string}|null} owner null = no owner */
async function transferParcel(parcelId, owner) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  await deps().db.query('UPDATE parcels SET owner_character_id = ? WHERE id = ?', [owner ? owner.id : null, parcel.id]);
  await reload();
  if (owner) _notifyCharacter(owner.id, `[Hold] You now own parcel "${parcel.name}" in ${_holdName(parcel.holdId)}.`);
  return ok(owner ? `Parcel "${parcel.name}" now belongs to ${owner.name}.` : `Parcel "${parcel.name}" has no owner now.`);
}

async function setParcelMinRank(parcelId, rankKey) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  let rank = null;
  if (rankKey && String(rankKey).toLowerCase() !== 'none') {
    rank = parcelLocks.findRank(_index, parcel.holdId, rankKey);
    if (!rank) return no(`No rank "${rankKey}" in ${_holdName(parcel.holdId)}.`);
  }
  await deps().db.query('UPDATE parcels SET min_rank_id = ? WHERE id = ?', [rank ? rank.id : null, parcel.id]);
  await reload();
  return ok(rank
    ? `Parcel "${parcel.name}" opens for ${rank.name} and above.`
    : `Parcel "${parcel.name}" opens for its owner and staff only.`);
}

async function setParcelLocked(parcelId, locked) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  await deps().db.query('UPDATE parcels SET locked = ? WHERE id = ?', [locked ? 1 : 0, parcel.id]);
  await reload();
  return ok(`Parcel "${parcel.name}" is ${locked ? 'locked' : 'unlocked (open to everyone)'}.`);
}

async function deleteParcel(parcelId) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  await deps().db.query('DELETE FROM parcels WHERE id = ?', [parcel.id]);
  await reload();
  return ok(`Parcel #${parcel.id} "${parcel.name}" deleted; its doors and containers are no longer locked.`);
}

/**
 * Assign a door/container to a parcel. A door's teleport partner, when it can
 * be read and is not already assigned, joins the parcel as an exit.
 */
async function addObject(parcelId, objectDesc, kind, { partnerDesc = null } = {}) {
  const parcel = _parcel(parcelId);
  if (!parcel) return no(`No parcel #${parcelId}.`);
  const desc = normalizeDesc(objectDesc);
  if (!desc) return no('That object has no FormDesc (hex:Plugin.esm).');
  if (kind !== 'door' && kind !== 'container') return no('Only doors and containers can be part of a parcel.');
  if ([..._index.holdstoneByHold.values()].includes(desc)) return no('That object is a holdstone.');
  const existing = _index.objectsByDesc.get(desc);
  if (existing && existing.parcelId !== parcel.id) {
    const other = _index.parcels.get(existing.parcelId);
    return no(`That ${kind} already belongs to parcel #${existing.parcelId}${other ? ` "${other.name}"` : ''}. Remove it there first.`);
  }
  const partner = kind === 'door' ? normalizeDesc(partnerDesc) : null;
  const { db } = deps();
  await db.query(
    `INSERT INTO parcel_objects (object_id, parcel_id, kind, locks, partner_object_id) VALUES (?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE kind = VALUES(kind), locks = 1, partner_object_id = COALESCE(VALUES(partner_object_id), partner_object_id)`,
    [desc, parcel.id, kind, partner]
  );
  let partnerNote = '';
  if (partner && !_index.objectsByDesc.has(partner)) {
    await db.query(
      'INSERT IGNORE INTO parcel_objects (object_id, parcel_id, kind, locks, partner_object_id) VALUES (?, ?, \'door\', 0, ?)',
      [partner, parcel.id, desc]
    );
    partnerNote = ' The other side of this door was added as an exit (never locked).';
  }
  await reload();
  return ok(`${kind === 'door' ? 'Door' : 'Container'} added to parcel "${parcel.name}".${partnerNote}`);
}

async function removeObject(objectDesc) {
  const desc = normalizeDesc(objectDesc);
  const existing = desc ? _index.objectsByDesc.get(desc) : null;
  if (!existing) return no('That object is not part of any parcel.');
  const parcel = _index.parcels.get(existing.parcelId);
  await deps().db.query('DELETE FROM parcel_objects WHERE object_id = ?', [desc]);
  await reload();
  return ok(`Removed from parcel${parcel ? ` "${parcel.name}"` : ''}.`);
}

async function setObjectLocks(objectDesc, locks) {
  const desc = normalizeDesc(objectDesc);
  const existing = desc ? _index.objectsByDesc.get(desc) : null;
  if (!existing) return no('That object is not part of any parcel.');
  await deps().db.query('UPDATE parcel_objects SET locks = ? WHERE object_id = ?', [locks ? 1 : 0, desc]);
  await reload();
  return ok(locks ? 'This side now locks.' : 'This side is now an exit: it never locks.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parceling tool (in memory, per actor)
// ─────────────────────────────────────────────────────────────────────────────

function startParcelTool(actorId, parcelId) {
  _tools.set(actorId, { parcelId: Number(parcelId) });
}

function startPlaceHoldstone(actorId, holdId) {
  _tools.set(actorId, { placeHoldId: holdId });
}

function stopTool(actorId) {
  return _tools.delete(actorId);
}

function toolOf(actorId) {
  return _tools.get(actorId) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock enforcement — `mp.onActivate` via core/activation-events.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synchronous. Returns `false` to block the vanilla activation.
 * - parceling tool on: doors/containers open the parcel menu instead;
 * - placing a holdstone: the activated object becomes that hold's stone;
 * - otherwise: block locked parcel objects for unauthorized characters.
 * Non-player casters (NPCs) and objects outside parcels are never blocked.
 */
function handleActivation(targetId, casterId) {
  const target = parseFormId(targetId);
  const caster = parseFormId(casterId);
  if (target === null || caster === null || target === caster) return undefined;
  const d = deps();
  const ch = d.commands.getActiveCharacterData(caster);
  if (!ch) return undefined;

  const tool = _tools.get(caster);
  if (tool && tool.placeHoldId) {
    _tools.delete(caster);
    const desc = descOf(target);
    setHoldstone(tool.placeHoldId, desc)
      .then((r) => d.commands.sendNotification(caster, `[Holdstone] ${r.message}`))
      .catch((err) => d.logger.error('[holdstones] place failed:', err.message));
    return false;
  }
  if (tool && tool.parcelId && !d.commands.getActiveCharacterData(target) && !physicalAnchorRegistry.has(target)) {
    try { d.openInteractionMenu(caster, target); } catch (err) { d.logger.error('[holdstones] tool menu failed:', err.message); }
    return false;
  }

  const verdict = parcelLocks.checkActivation(_index, target, actorOf(caster));
  if (!verdict.known || verdict.allowed) return undefined;
  d.commands.sendNotification(caster, LOCKED_MESSAGE);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdstone panel payload
// ─────────────────────────────────────────────────────────────────────────────

async function holdPayload(holdId, actor, targetId = null) {
  const members = parcelLocks.membersOf(_index, holdId);
  const parcels = parcelLocks.parcelsOf(_index, holdId);
  const names = await characterNames([
    ...members.map((m) => m.characterId),
    ...parcels.map((p) => p.ownerCharacterId)
  ]);
  const mine = parcelLocks.memberRank(_index, holdId, actor.characterId);
  const canManage = parcelLocks.canManageHold(_index, holdId, actor);
  const label = (id) => {
    const n = names.get(id);
    return n ? `${n.name}${n.number ? ` #${n.number}` : ''}` : `character ${id}`;
  };
  return {
    holdId,
    holdName: _holdName(holdId),
    targetId,
    yourRank: mine ? mine.name : null,
    canManage,
    isStaff: actor.isStaff,
    ranks: parcelLocks.ranksOf(_index, holdId).map((r) => ({ key: r.key, name: r.name, position: r.position, isLeader: r.isLeader })),
    members: members.map((m) => ({ name: label(m.characterId), rank: m.rank.name, rankKey: m.rank.key })),
    parcels: parcels.map((p) => {
      const min = p.minRankId != null ? _index.ranks.get(p.minRankId) : null;
      const objects = parcelLocks.objectsOf(_index, p.id);
      return {
        id: p.id,
        name: p.name,
        owner: p.ownerCharacterId != null ? label(p.ownerCharacterId) : null,
        mine: p.ownerCharacterId != null && p.ownerCharacterId === actor.characterId,
        minRank: min ? min.name : null,
        locked: p.locked,
        doors: objects.filter((o) => o.kind === 'door').length,
        containers: objects.filter((o) => o.kind === 'container').length
      };
    })
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction Framework
// ─────────────────────────────────────────────────────────────────────────────

function _holdOfTarget(ctx) {
  return parcelLocks.holdOfStone(_index, ctx.target.formId);
}

function _ctxActor(ctx) {
  return { actorId: ctx.actorId, characterId: ctx.characterId, isStaff: Boolean(deps().isStaff(ctx.actorId)) };
}

function _parcelInHold(ctx, holdId) {
  const parcel = _parcel(ctx.data.parcelId);
  return parcel && parcel.holdId === holdId ? parcel : null;
}

async function _refreshPanel(ctx, holdId) {
  deps().sendModal(ctx.actorId, 'holdstone:update', await holdPayload(holdId, _ctxActor(ctx), ctx.target.formId));
}

function registerInteractions() {
  const R = interactionRegistry;
  const stone = {
    module: MODULE_ID,
    target: R.TARGET_TYPES.OBJECT,
    section: 'holdstone',
    distance: HOLDSTONE_RANGE
  };
  const isStone = async (ctx) => Boolean(_holdOfTarget(ctx));
  const isManager = async (ctx) => {
    const holdId = _holdOfTarget(ctx);
    return Boolean(holdId) && parcelLocks.canManageHold(_index, holdId, _ctxActor(ctx));
  };
  /** Runs `fn(holdId, parcel?)` after re-checking leadership at execute time. */
  const managed = (needsParcel, fn) => async (ctx) => {
    const holdId = _holdOfTarget(ctx);
    if (!holdId) return { message: 'This is not a holdstone.' };
    if (!parcelLocks.canManageHold(_index, holdId, _ctxActor(ctx))) {
      return { message: 'Only the leaders of this hold can do that.' };
    }
    let parcel = null;
    if (needsParcel) {
      parcel = _parcelInHold(ctx, holdId);
      if (!parcel) return { message: `No parcel #${ctx.data.parcelId} in ${_holdName(holdId)}.` };
    }
    const result = await fn(ctx, holdId, parcel);
    if (result.ok) await _refreshPanel(ctx, holdId);
    return { message: `[Hold] ${result.message}` };
  };

  R.register({
    ...stone,
    id: 'holdstone.view',
    label: 'Hold',
    order: 10,
    audit: R.AUDIT_LEVELS.TRACE,
    canSee: isStone,
    execute: async (ctx) => {
      const holdId = _holdOfTarget(ctx);
      if (!holdId) return { message: 'This is not a holdstone.' };
      deps().sendModal(ctx.actorId, 'holdstone:open', await holdPayload(holdId, _ctxActor(ctx), ctx.target.formId));
      return { message: null };
    }
  });

  R.register({
    ...stone,
    id: 'holdstone.set_rank',
    label: 'Set a rank',
    order: 20,
    canSee: isManager,
    schema: {
      player: { type: 'int', label: 'Character number', min: 1, max: 5000, required: true },
      rank: { type: 'string', label: 'Rank key (or none)', min: 2, max: 32, required: true }
    },
    execute: managed(false, async (ctx, holdId) => {
      const target = await characterByNumber(ctx.data.player);
      if (!target) return no(`No character with number #${ctx.data.player}.`);
      return setMemberRank(_ctxActor(ctx), holdId, target, ctx.data.rank);
    })
  });

  R.register({
    ...stone,
    id: 'holdstone.create_parcel',
    label: 'Create a parcel',
    order: 30,
    canSee: isManager,
    schema: {
      name: { type: 'string', label: 'Parcel name', min: 2, max: NAME_MAX, required: true },
      minRank: { type: 'string', label: 'Minimum rank key (or none)', max: 32, default: 'none' }
    },
    execute: managed(false, (ctx, holdId) => createParcel(holdId, ctx.data.name, ctx.data.minRank))
  });

  R.register({
    ...stone,
    id: 'holdstone.rename_parcel',
    label: 'Rename a parcel',
    order: 40,
    canSee: isManager,
    schema: {
      parcelId: { type: 'int', label: 'Parcel number', min: 1, required: true },
      name: { type: 'string', label: 'New name', min: 2, max: NAME_MAX, required: true }
    },
    execute: managed(true, (ctx, holdId, parcel) => renameParcel(parcel.id, ctx.data.name))
  });

  R.register({
    ...stone,
    id: 'holdstone.transfer_parcel',
    label: 'Transfer a parcel',
    order: 50,
    canSee: isManager,
    schema: {
      parcelId: { type: 'int', label: 'Parcel number', min: 1, required: true },
      owner: { type: 'int', label: 'New owner number (0 = none)', min: 0, max: 5000, required: true }
    },
    execute: managed(true, async (ctx, holdId, parcel) => {
      if (ctx.data.owner === 0) return transferParcel(parcel.id, null);
      const owner = await characterByNumber(ctx.data.owner);
      if (!owner) return no(`No character with number #${ctx.data.owner}.`);
      return transferParcel(parcel.id, owner);
    })
  });

  R.register({
    ...stone,
    id: 'holdstone.parcel_rank',
    label: 'Set parcel minimum rank',
    order: 60,
    canSee: isManager,
    schema: {
      parcelId: { type: 'int', label: 'Parcel number', min: 1, required: true },
      rank: { type: 'string', label: 'Minimum rank key (or none)', min: 2, max: 32, required: true }
    },
    execute: managed(true, (ctx, holdId, parcel) => setParcelMinRank(parcel.id, ctx.data.rank))
  });

  R.register({
    ...stone,
    id: 'holdstone.lock_parcel',
    label: 'Lock or unlock a parcel',
    order: 70,
    // Owners lock/unlock their own parcels from the stone too.
    canSee: async (ctx) => {
      const holdId = _holdOfTarget(ctx);
      if (!holdId) return false;
      const actor = _ctxActor(ctx);
      return parcelLocks.parcelsOf(_index, holdId).some((p) => parcelLocks.canLockParcel(_index, p, actor));
    },
    schema: {
      parcelId: { type: 'int', label: 'Parcel number', min: 1, required: true },
      locked: { type: 'bool', label: 'Locked', default: true }
    },
    execute: async (ctx) => {
      const holdId = _holdOfTarget(ctx);
      const parcel = holdId ? _parcelInHold(ctx, holdId) : null;
      if (!parcel) return { message: `[Hold] No parcel #${ctx.data.parcelId} here.` };
      if (!parcelLocks.canLockParcel(_index, parcel, _ctxActor(ctx))) {
        return { message: '[Hold] Only the owner or the leaders can lock this parcel.' };
      }
      const result = await setParcelLocked(parcel.id, ctx.data.locked);
      if (result.ok) await _refreshPanel(ctx, holdId);
      return { message: `[Hold] ${result.message}` };
    }
  });

  R.register({
    ...stone,
    id: 'holdstone.parcel_tool',
    label: 'Parceling tool',
    order: 80,
    canSee: isManager,
    schema: {
      parcelId: { type: 'int', label: 'Parcel number', min: 1, required: true }
    },
    execute: managed(true, async (ctx, holdId, parcel) => {
      startParcelTool(ctx.actorId, parcel.id);
      return ok(`Parceling tool on for "${parcel.name}". Press E on a door or container to add or remove it. ` +
        'Choose "Stop parceling tool" (or /parcel tool off) when done.');
    })
  });

  // ── Parceling tool actions on doors and containers ─────────────────────────
  const tool = {
    module: MODULE_ID,
    target: R.TARGET_TYPES.OBJECT,
    section: 'parcel',
    distance: PARCEL_TOOL_RANGE,
    audit: R.AUDIT_LEVELS.ADMIN
  };
  const toolParcel = (ctx) => {
    const t = _tools.get(ctx.actorId);
    const parcel = t && t.parcelId ? _parcel(t.parcelId) : null;
    if (!parcel) return null;
    return parcelLocks.canManageHold(_index, parcel.holdId, _ctxActor(ctx)) ? parcel : null;
  };
  const objectHere = (ctx) => {
    const desc = descOf(ctx.target.formId);
    return desc ? _index.objectsByDesc.get(desc) || null : null;
  };
  const toolSees = (fn) => async (ctx) => Boolean(toolParcel(ctx)) && !parcelLocks.holdOfStone(_index, ctx.target.formId) && fn(ctx);

  R.register({
    ...tool,
    id: 'parcel.add_object',
    label: 'Add to parcel…',
    order: 10,
    canSee: toolSees((ctx) => {
      const o = objectHere(ctx);
      return !o || o.parcelId !== toolParcel(ctx).id;
    }),
    execute: async (ctx) => {
      const parcel = toolParcel(ctx);
      if (!parcel) return { message: '[Parcel] Your parceling tool is off.' };
      const kind = detectKind(ctx.target.formId);
      if (!kind) return { message: '[Parcel] Only doors and containers can be part of a parcel.' };
      const desc = descOf(ctx.target.formId);
      const partnerDesc = kind === 'door' ? findTeleportPartner(ctx.target.formId) : null;
      const result = await addObject(parcel.id, desc, kind, { partnerDesc });
      return { message: `[Parcel] ${result.message}` };
    }
  });

  R.register({
    ...tool,
    id: 'parcel.remove_object',
    label: 'Remove from parcel',
    order: 20,
    canSee: toolSees((ctx) => Boolean(objectHere(ctx))),
    execute: async (ctx) => {
      const object = objectHere(ctx);
      const parcel = object ? _parcel(object.parcelId) : null;
      if (!object || !parcel) return { message: '[Parcel] That object is not part of any parcel.' };
      if (!parcelLocks.canManageHold(_index, parcel.holdId, _ctxActor(ctx))) {
        return { message: '[Parcel] Only the leaders of that hold can change this parcel.' };
      }
      const result = await removeObject(object.objectId);
      return { message: `[Parcel] ${result.message}` };
    }
  });

  R.register({
    ...tool,
    id: 'parcel.toggle_side',
    label: 'Lock this side / make it an exit',
    order: 30,
    canSee: toolSees((ctx) => {
      const o = objectHere(ctx);
      return Boolean(o && o.kind === 'door');
    }),
    execute: async (ctx) => {
      const object = objectHere(ctx);
      const parcel = object ? _parcel(object.parcelId) : null;
      if (!object || !parcel) return { message: '[Parcel] That door is not part of any parcel.' };
      if (!parcelLocks.canManageHold(_index, parcel.holdId, _ctxActor(ctx))) {
        return { message: '[Parcel] Only the leaders of that hold can change this parcel.' };
      }
      const result = await setObjectLocks(object.objectId, !object.locks);
      return { message: `[Parcel] ${result.message}` };
    }
  });

  R.register({
    ...tool,
    id: 'parcel.stop_tool',
    label: 'Stop parceling tool',
    order: 90,
    audit: R.AUDIT_LEVELS.TRACE,
    canSee: async (ctx) => _tools.has(ctx.actorId),
    execute: async (ctx) => {
      stopTool(ctx.actorId);
      return { message: '[Parcel] Parceling tool off. Doors and containers open normally again.' };
    }
  });
}

function registerPhysicalAnchors() {
  physicalAnchorRegistry.register({
    targetType: interactionRegistry.TARGET_TYPES.OBJECT,
    list: async () => [..._index.holdstoneById.keys()].map((targetId) => ({ targetId }))
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UI events (holdstone panel buttons)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The panel itself only sends `interaction:execute` for its buttons (same
 * pipeline as the menu). `holdstone:close` is accepted so the CEF has a
 * route; nothing else is trusted from it.
 */
async function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string' || !uiEvent.type.startsWith('holdstone:')) return false;
  return uiEvent.type === 'holdstone:close';
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff commands (fallback)
// ─────────────────────────────────────────────────────────────────────────────

function _staffGuard(actorId) {
  const d = deps();
  if (d.isStaff(actorId)) return true;
  d.commands.sendNotification(actorId, 'Staff only. Leaders manage their hold at the holdstone.');
  return false;
}

function _say(actorId, text) {
  deps().commands.sendNotification(actorId, text);
}

function _reply(actorId, prefix) {
  return (r) => _say(actorId, `[${prefix}] ${r.message}`);
}

function _actorIdFromArg(word) {
  if (!/^0x[0-9a-f]+$/i.test(word || '')) return null;
  return Number.parseInt(word.slice(2), 16);
}

function _characterFromActorArg(word) {
  const actorId = _actorIdFromArg(word);
  const ch = actorId ? deps().commands.getActiveCharacterData(actorId) : null;
  return ch ? { id: ch.characterId, name: `${ch.firstName} ${ch.lastName}` } : null;
}

const HOLDSTONE_HELP =
  '/holdstone list · /holdstone place <hold> (then press E on the object) · /holdstone set <hold> <formDesc> · ' +
  '/holdstone clear <hold> · /holdstone ranks <hold> · /holdstone addrank <hold> <key> <position> <leader|member> <name> · ' +
  '/holdstone delrank <hold> <key> · /holdrank <hold> <player#> <rank|none>';

const PARCEL_HELP =
  '/parcel list <hold> · /parcel create <hold> <name> · /parcel rename <id> <name> · /parcel rank <id> <rank|none> · ' +
  '/parcel lock <id> · /parcel unlock <id> · /parcel disown <id> · /parcel delete <id> · /parcel info <id> · ' +
  '/parcel add <id> <formDesc> <door|container> · /parcel remove <formDesc> · /parcel tool <id|off> · /parcelowner <id> <player#>';

async function handleHoldstoneCommand(actorId, args) {
  if (!_staffGuard(actorId)) return;
  const [sub, ...rest] = String(args || '').trim().split(/\s+/);
  const reply = _reply(actorId, 'Holdstone');
  switch ((sub || '').toLowerCase()) {
    case 'list': {
      const lines = [..._index.holds.keys()].map((holdId) => {
        const stoneDesc = _index.holdstoneByHold.get(holdId);
        return `${holdId}: ${stoneDesc || 'no stone'}, ${parcelLocks.membersOf(_index, holdId).length} members, ${parcelLocks.parcelsOf(_index, holdId).length} parcels`;
      });
      _say(actorId, `[Holdstone] ${lines.join(' · ') || 'No holds.'}`);
      return;
    }
    case 'place':
      if (!_index.holds.has(rest[0])) return _say(actorId, `[Holdstone] Unknown hold "${rest[0] || ''}".`);
      startPlaceHoldstone(actorId, rest[0]);
      return _say(actorId, `[Holdstone] Press E on the object that will be the ${_holdName(rest[0])} holdstone.`);
    case 'set':
      return reply(await setHoldstone(rest[0], rest[1]));
    case 'clear':
      return reply(await clearHoldstone(rest[0]));
    case 'ranks': {
      const ranks = parcelLocks.ranksOf(_index, rest[0]);
      return _say(actorId, `[Holdstone] ${_holdName(rest[0])}: ${ranks.map((r) => `${r.position} ${r.key} (${r.name}${r.isLeader ? ', leader' : ''})`).join(' < ') || 'no ranks'}`);
    }
    case 'addrank':
      return reply(await addRank(rest[0], rest[1], Number(rest[2]), rest[3] === 'leader', rest.slice(4).join(' ')));
    case 'delrank':
      return reply(await removeRank(rest[0], rest[1]));
    default:
      return _say(actorId, HOLDSTONE_HELP);
  }
}

async function handleHoldRankCommand(actorId, args) {
  if (!_staffGuard(actorId)) return;
  const [holdId, actorWord, rankKey] = String(args || '').trim().split(/\s+/);
  const target = _characterFromActorArg(actorWord);
  if (!target) return _say(actorId, 'Usage: /holdrank <hold> <player#> <rank|none>');
  const r = await setMemberRank(actorOf(actorId), holdId, target, rankKey || 'none');
  _say(actorId, `[Hold] ${r.message}`);
}

async function handleParcelOwnerCommand(actorId, args) {
  if (!_staffGuard(actorId)) return;
  const [parcelId, actorWord] = String(args || '').trim().split(/\s+/);
  const owner = _characterFromActorArg(actorWord);
  if (!owner) return _say(actorId, 'Usage: /parcelowner <parcelId> <player#>');
  _reply(actorId, 'Parcel')(await transferParcel(Number(parcelId), owner));
}

async function handleParcelCommand(actorId, args) {
  const [sub, ...rest] = String(args || '').trim().split(/\s+/);
  const reply = _reply(actorId, 'Parcel');
  const lower = (sub || '').toLowerCase();
  if (lower === 'tool' && (rest[0] || '').toLowerCase() === 'off') {
    stopTool(actorId);
    return _say(actorId, '[Parcel] Parceling tool off.');
  }
  if (!_staffGuard(actorId)) return;
  const id = Number(rest[0]);
  switch (lower) {
    case 'list': {
      const parcels = parcelLocks.parcelsOf(_index, rest[0]);
      return _say(actorId, `[Parcel] ${_holdName(rest[0])}: ${parcels.map((p) => `#${p.id} ${p.name}${p.locked ? '' : ' (unlocked)'}`).join(' · ') || 'no parcels'}`);
    }
    case 'info': {
      const p = _parcel(id);
      if (!p) return _say(actorId, `[Parcel] No parcel #${rest[0]}.`);
      const min = p.minRankId != null ? _index.ranks.get(p.minRankId) : null;
      const objects = parcelLocks.objectsOf(_index, p.id);
      return _say(actorId, `[Parcel] #${p.id} ${p.name} (${p.holdId}) owner=${p.ownerCharacterId ?? 'none'} ` +
        `min=${min ? min.key : 'owner only'} ${p.locked ? 'locked' : 'unlocked'} · ` +
        `${objects.map((o) => `${o.kind}${o.locks ? '' : '(exit)'} ${o.objectId}`).join(', ') || 'no objects'}`);
    }
    case 'create':
      return reply(await createParcel(rest[0], rest.slice(1).join(' ')));
    case 'rename':
      return reply(await renameParcel(id, rest.slice(1).join(' ')));
    case 'rank':
      return reply(await setParcelMinRank(id, rest[1]));
    case 'lock':
    case 'unlock':
      return reply(await setParcelLocked(id, lower === 'lock'));
    case 'disown':
      return reply(await transferParcel(id, null));
    case 'delete':
      return reply(await deleteParcel(id));
    case 'add':
      return reply(await addObject(id, rest[1], (rest[2] || '').toLowerCase()));
    case 'remove':
      return reply(await removeObject(rest[0]));
    case 'tool': {
      const p = _parcel(id);
      if (!p) return _say(actorId, `[Parcel] No parcel #${rest[0]}.`);
      startParcelTool(actorId, p.id);
      return _say(actorId, `[Parcel] Parceling tool on for "${p.name}". Press E on doors and containers; /parcel tool off when done.`);
    }
    default:
      return _say(actorId, PARCEL_HELP);
  }
}

function commandDefs() {
  const wrap = (fn) => (actorId, args) => fn(actorId, args).catch((err) => {
    deps().logger.error('[holdstones] command failed:', err.message);
    _say(actorId, 'Could not complete that. Check the server log.');
  });
  return [
    { name: '/holdstone', handler: wrap(handleHoldstoneCommand), description: '[Staff] Set up holdstones and hold ranks', usage: '/holdstone [list|place|set|clear|ranks|addrank|delrank]' },
    { name: '/holdrank', handler: wrap(handleHoldRankCommand), description: '[Staff] Set a player\'s rank in a hold', usage: '/holdrank <hold> <player#> <rank|none>' },
    { name: '/parcel', handler: wrap(handleParcelCommand), description: '[Staff] Manage parcels (doors and containers that lock)', usage: '/parcel [list|create|info|rename|rank|lock|unlock|disown|delete|add|remove|tool]' },
    { name: '/parcelowner', handler: wrap(handleParcelOwnerCommand), description: '[Staff] Give a parcel to a player', usage: '/parcelowner <parcelId> <player#>' }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function initialize(overrides = {}) {
  configure(overrides);
  registerPhysicalAnchors();
  await reload();
  registerInteractions();
  activationEvents.subscribe(ACTIVATION_SUBSCRIBER, handleActivation);
  const d = deps();
  if (typeof d.commands.onCharacterRemoved === 'function') d.commands.onCharacterRemoved(stopTool);
  d.logger.log(`[holdstones] ${_index.holdstoneByHold.size} holdstones, ${_index.parcels.size} parcels, ${_index.objectsByDesc.size} locked objects loaded.`);
}

function shutdown() {
  activationEvents.unsubscribe(ACTIVATION_SUBSCRIBER);
  interactionRegistry.unregisterModule(MODULE_ID);
  _tools.clear();
}

function _resetForTest() {
  _index = parcelLocks.EMPTY_INDEX;
  _tools.clear();
  _deps = null;
}

module.exports = {
  MODULE_ID,
  LOCKED_MESSAGE,
  configure,
  getIndex,
  reload,
  normalizeDesc,
  detectKind,
  findTeleportPartner,
  characterByNumber,
  setHoldstone,
  clearHoldstone,
  addRank,
  removeRank,
  setMemberRank,
  createParcel,
  renameParcel,
  transferParcel,
  setParcelMinRank,
  setParcelLocked,
  deleteParcel,
  addObject,
  removeObject,
  setObjectLocks,
  startParcelTool,
  startPlaceHoldstone,
  stopTool,
  toolOf,
  handleActivation,
  holdPayload,
  registerInteractions,
  registerPhysicalAnchors,
  handleUiEvent,
  handleHoldstoneCommand,
  handleParcelCommand,
  handleHoldRankCommand,
  handleParcelOwnerCommand,
  commandDefs,
  initialize,
  shutdown,
  _setIndexForTest,
  _resetForTest
};
