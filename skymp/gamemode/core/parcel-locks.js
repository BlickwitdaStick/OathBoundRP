/**
 * core/parcel-locks.js
 *
 * Pure part of holdstones and parcels: an in-memory index of holdstones,
 * hold rank ladders, memberships, parcels and parcel objects, plus every
 * permission decision made from it. No `mp`, no database — the service
 * (`holdstone-service.js`) loads rows into `buildIndex` and asks questions.
 *
 * Why an index and not a query per activation: `mp.onActivate` is synchronous
 * (see core/activation-events.js). To block a door the answer has to exist
 * before the hook returns, so it is read from memory. The service rebuilds
 * the index after every change it writes, and on boot.
 *
 * Objects are stored by FormDesc (`hex:Plugin.esm`) in the database. The
 * index also keeps them by the numeric FormID the running server uses, which
 * `resolveId` (normally `mp.getIdFromDesc`) provides at build time.
 */

'use strict';

/**
 * @typedef {{id:number, holdId:string, key:string, name:string, position:number, isLeader:boolean}} Rank
 * @typedef {{id:number, holdId:string, name:string, ownerCharacterId:number|null, minRankId:number|null, locked:boolean}} Parcel
 * @typedef {{objectId:string, formId:number|null, parcelId:number, kind:'door'|'container', locks:boolean, partnerObjectId:string|null}} ParcelObject
 */

function _int(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function _key(holdId, characterId) {
  return `${holdId}:${characterId}`;
}

/**
 * @param {object} snapshot rows as read from the database
 * @param {Array<{id:string, name:string}>} [snapshot.holds]
 * @param {Array<{hold_id:string, object_id:string}>} [snapshot.holdstones]
 * @param {Array<object>} [snapshot.ranks]
 * @param {Array<{hold_id:string, character_id:number, rank_id:number}>} [snapshot.members]
 * @param {Array<object>} [snapshot.parcels]
 * @param {Array<object>} [snapshot.objects]
 * @param {(desc: string) => number|null} [resolveId] FormDesc → numeric FormID
 */
function buildIndex(snapshot = {}, resolveId = () => null) {
  const safeResolve = (desc) => {
    try {
      const id = resolveId(desc);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  };

  const holds = new Map();
  for (const row of snapshot.holds || []) holds.set(String(row.id), String(row.name || row.id));

  const holdstoneByHold = new Map();
  const holdstoneById = new Map();
  for (const row of snapshot.holdstones || []) {
    holdstoneByHold.set(String(row.hold_id), String(row.object_id));
    const formId = safeResolve(String(row.object_id));
    if (formId) holdstoneById.set(formId, String(row.hold_id));
  }

  /** @type {Map<number, Rank>} */
  const ranks = new Map();
  /** @type {Map<string, Rank[]>} */
  const ranksByHold = new Map();
  for (const row of snapshot.ranks || []) {
    const rank = {
      id: _int(row.id),
      holdId: String(row.hold_id),
      key: String(row.rank_key),
      name: String(row.name),
      position: _int(row.position) || 0,
      isLeader: Boolean(Number(row.is_leader))
    };
    ranks.set(rank.id, rank);
    if (!ranksByHold.has(rank.holdId)) ranksByHold.set(rank.holdId, []);
    ranksByHold.get(rank.holdId).push(rank);
  }
  for (const list of ranksByHold.values()) list.sort((a, b) => a.position - b.position);

  /** @type {Map<string, number>} */
  const members = new Map();
  for (const row of snapshot.members || []) {
    members.set(_key(String(row.hold_id), _int(row.character_id)), _int(row.rank_id));
  }

  /** @type {Map<number, Parcel>} */
  const parcels = new Map();
  for (const row of snapshot.parcels || []) {
    const parcel = {
      id: _int(row.id),
      holdId: String(row.hold_id),
      name: String(row.name),
      ownerCharacterId: row.owner_character_id == null ? null : _int(row.owner_character_id),
      minRankId: row.min_rank_id == null ? null : _int(row.min_rank_id),
      locked: row.locked === undefined ? true : Boolean(Number(row.locked))
    };
    parcels.set(parcel.id, parcel);
  }

  /** @type {Map<string, ParcelObject>} */
  const objectsByDesc = new Map();
  /** @type {Map<number, ParcelObject>} */
  const objectsById = new Map();
  for (const row of snapshot.objects || []) {
    const object = {
      objectId: String(row.object_id),
      formId: safeResolve(String(row.object_id)),
      parcelId: _int(row.parcel_id),
      kind: row.kind === 'door' ? 'door' : 'container',
      locks: row.locks === undefined ? true : Boolean(Number(row.locks)),
      partnerObjectId: row.partner_object_id ? String(row.partner_object_id) : null
    };
    objectsByDesc.set(object.objectId, object);
    if (object.formId) objectsById.set(object.formId, object);
  }

  return { holds, holdstoneByHold, holdstoneById, ranks, ranksByHold, members, parcels, objectsByDesc, objectsById };
}

const EMPTY_INDEX = buildIndex();

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Rank|null} */
function memberRank(index, holdId, characterId) {
  if (!Number.isSafeInteger(characterId)) return null;
  const rankId = index.members.get(_key(holdId, characterId));
  return rankId == null ? null : (index.ranks.get(rankId) || null);
}

/** @returns {Rank|null} */
function findRank(index, holdId, rankKey) {
  if (typeof rankKey !== 'string') return null;
  const key = rankKey.trim().toLowerCase();
  return (index.ranksByHold.get(holdId) || []).find((r) => r.key === key) || null;
}

function ranksOf(index, holdId) {
  return index.ranksByHold.get(holdId) || [];
}

function holdOfStone(index, formId) {
  return index.holdstoneById.get(formId) || null;
}

function parcelsOf(index, holdId) {
  return [...index.parcels.values()].filter((p) => p.holdId === holdId).sort((a, b) => a.id - b.id);
}

function objectsOf(index, parcelId) {
  return [...index.objectsByDesc.values()].filter((o) => o.parcelId === parcelId);
}

function membersOf(index, holdId) {
  const out = [];
  for (const [key, rankId] of index.members) {
    const sep = key.lastIndexOf(':');
    if (key.slice(0, sep) !== holdId) continue;
    const rank = index.ranks.get(rankId);
    if (rank) out.push({ characterId: Number(key.slice(sep + 1)), rank });
  }
  return out.sort((a, b) => (b.rank.position - a.rank.position) || (a.characterId - b.characterId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this character open the doors/containers of `parcel`?
 *
 * Order: unlocked parcel → staff → owner → rank at or above the minimum in
 * the parcel's hold. A parcel with no minimum rank is owner + staff only.
 *
 * @param {object} index
 * @param {Parcel} parcel
 * @param {{characterId:number|null, isStaff?:boolean}} actor
 * @returns {{allowed:boolean, reason:'unlocked'|'staff'|'owner'|'rank'|'denied'}}
 */
function canOpenParcel(index, parcel, actor) {
  if (!parcel.locked) return { allowed: true, reason: 'unlocked' };
  if (actor.isStaff) return { allowed: true, reason: 'staff' };
  if (parcel.ownerCharacterId != null && actor.characterId === parcel.ownerCharacterId) {
    return { allowed: true, reason: 'owner' };
  }
  if (parcel.minRankId != null) {
    const min = index.ranks.get(parcel.minRankId);
    const mine = memberRank(index, parcel.holdId, actor.characterId);
    if (min && mine && mine.position >= min.position) return { allowed: true, reason: 'rank' };
  }
  return { allowed: false, reason: 'denied' };
}

/**
 * Decision for one native activation. An object that is not in any parcel is
 * `known:false` and is never blocked.
 *
 * @param {object} index
 * @param {number} formId
 * @param {{characterId:number|null, isStaff?:boolean}} actor
 */
function checkActivation(index, formId, actor) {
  const object = index.objectsById.get(formId);
  if (!object) return { known: false, allowed: true, reason: 'unknown' };
  if (!object.locks) return { known: true, allowed: true, reason: 'exit', object };
  const parcel = index.parcels.get(object.parcelId);
  if (!parcel) return { known: false, allowed: true, reason: 'unknown' };
  return { known: true, object, parcel, ...canOpenParcel(index, parcel, actor) };
}

/** Leader of the hold (a member whose rank is a leader rank) or staff. */
function canManageHold(index, holdId, actor) {
  if (actor.isStaff) return true;
  const rank = memberRank(index, holdId, actor.characterId);
  return Boolean(rank && rank.isLeader);
}

/** Owners may lock/unlock their own parcel; leaders and staff any in their hold. */
function canLockParcel(index, parcel, actor) {
  if (canManageHold(index, parcel.holdId, actor)) return true;
  return parcel.ownerCharacterId != null && actor.characterId === parcel.ownerCharacterId;
}

/**
 * May `actor` move `targetCharacterId` to `newRank` (null = remove)?
 * Staff: always. Leaders: only below their own rank, and only for members
 * currently below them — a Steward cannot crown a Jarl or demote one.
 *
 * @returns {{ok:true}|{ok:false, message:string}}
 */
function canAssignRank(index, holdId, actor, targetCharacterId, newRank) {
  if (actor.isStaff) return { ok: true };
  const mine = memberRank(index, holdId, actor.characterId);
  if (!mine || !mine.isLeader) return { ok: false, message: 'Only the leaders of this hold can set ranks.' };
  if (targetCharacterId === actor.characterId) return { ok: false, message: 'You cannot change your own rank.' };
  const theirs = memberRank(index, holdId, targetCharacterId);
  if (theirs && theirs.position >= mine.position) {
    return { ok: false, message: `${theirs.name} is not below your rank; only staff or a higher rank can change it.` };
  }
  if (newRank && newRank.position >= mine.position) {
    return { ok: false, message: `You can only grant ranks below ${mine.name}.` };
  }
  return { ok: true };
}

module.exports = {
  EMPTY_INDEX,
  buildIndex,
  memberRank,
  findRank,
  ranksOf,
  holdOfStone,
  parcelsOf,
  objectsOf,
  membersOf,
  canOpenParcel,
  checkActivation,
  canManageHold,
  canLockParcel,
  canAssignRank
};
