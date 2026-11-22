/**
 * core/parcel-locks.js
 *
 * Pure part of stones and parcels: an in-memory index of organizations (each
 * with its stone), their rank ladders, memberships, parcels and parcel
 * objects, plus every permission decision made from it. No `mp`, no database
 * — the service (`holdstone-service.js`) loads rows into `buildIndex` and asks
 * questions.
 *
 * An organization can answer to a parent (Riverwood answers to Whiterun): the
 * parent's leaders also lead the child — its ranks, members and parcels — as
 * if they stood above its whole ladder. Opening locked doors is NOT inherited:
 * it still needs the parcel's own organization rank (or owner/staff).
 *
 * An organization is a hold, a town, a faction, a thanedom or a council
 * (migration-v41-stone-organizations.sql). Each has its own stone activator in
 * Oathbound_Holdstone.esp; any placed reference of that activator is its
 * stone, so the index maps activator (base) FormDesc → organization. Ranks, membership and parcel access
 * are all per organization: a Legion officer has no say over Solitude's city
 * parcels unless they also hold a rank in Solitude.
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

const ORG_KINDS = Object.freeze(['hold', 'town', 'faction', 'thanedom', 'council']);

/** Ladder a new organization starts with, per kind. Staff can change it. */
const DEFAULT_LADDERS = Object.freeze({
  hold: [['citizen', 'Citizen', 10, false], ['guard', 'Guard', 20, false], ['steward', 'Steward', 30, true], ['jarl', 'Jarl', 40, true]],
  town: [['resident', 'Resident', 10, false], ['guard', 'Guard', 20, false], ['reeve', 'Reeve', 30, true]],
  faction: [['recruit', 'Recruit', 10, false], ['member', 'Member', 20, false], ['officer', 'Officer', 30, true], ['leader', 'Leader', 40, true]],
  thanedom: [['retainer', 'Retainer', 10, false], ['housecarl', 'Housecarl', 20, false], ['thane', 'Thane', 30, true]],
  council: [['councilor', 'Councilor', 10, false], ['elder', 'Elder', 20, true]]
});

/**
 * @typedef {{id:string, name:string, kind:string, holdId:string|null, parentId:string|null, baseId:string|null}} Org
 * @typedef {{id:number, orgId:string, key:string, name:string, position:number, isLeader:boolean}} Rank
 * @typedef {{id:number, orgId:string, holdId:string|null, name:string, ownerCharacterId:number|null, minRankId:number|null, locked:boolean}} Parcel
 * @typedef {{objectId:string, formId:number|null, parcelId:number, kind:'door'|'container', locks:boolean, partnerObjectId:string|null}} ParcelObject
 */

function _int(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function _key(orgId, characterId) {
  return `${orgId}:${characterId}`;
}

/**
 * @param {object} snapshot rows as read from the database
 * @param {Array<{id:string, name:string}>} [snapshot.holds]
 * @param {Array<{id:string, name:string, kind:string, hold_id:string|null, base_id:string|null}>} [snapshot.orgs]
 * @param {Array<object>} [snapshot.ranks]
 * @param {Array<{org_id:string, character_id:number, rank_id:number}>} [snapshot.members]
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

  /** @type {Map<string, string>} hold id → name (locations) */
  const holds = new Map();
  for (const row of snapshot.holds || []) holds.set(String(row.id), String(row.name || row.id));

  /** @type {Map<string, Org>} */
  const orgs = new Map();
  /** @type {Map<string, string>} stone activator FormDesc (lowercase) → org id */
  const orgByBase = new Map();
  for (const row of snapshot.orgs || []) {
    const org = {
      id: String(row.id),
      name: String(row.name || row.id),
      kind: ORG_KINDS.includes(row.kind) ? row.kind : 'faction',
      holdId: row.hold_id ? String(row.hold_id) : null,
      parentId: row.parent_id ? String(row.parent_id) : null,
      baseId: row.base_id ? String(row.base_id) : null
    };
    orgs.set(org.id, org);
    if (org.baseId) orgByBase.set(org.baseId.toLowerCase(), org.id);
  }

  /** @type {Map<number, Rank>} */
  const ranks = new Map();
  /** @type {Map<string, Rank[]>} */
  const ranksByOrg = new Map();
  for (const row of snapshot.ranks || []) {
    const rank = {
      id: _int(row.id),
      orgId: String(row.org_id),
      key: String(row.rank_key),
      name: String(row.name),
      position: _int(row.position) || 0,
      isLeader: Boolean(Number(row.is_leader))
    };
    ranks.set(rank.id, rank);
    if (!ranksByOrg.has(rank.orgId)) ranksByOrg.set(rank.orgId, []);
    ranksByOrg.get(rank.orgId).push(rank);
  }
  for (const list of ranksByOrg.values()) list.sort((a, b) => a.position - b.position);

  /** @type {Map<string, number>} */
  const members = new Map();
  for (const row of snapshot.members || []) {
    members.set(_key(String(row.org_id), _int(row.character_id)), _int(row.rank_id));
  }

  /** @type {Map<number, Parcel>} */
  const parcels = new Map();
  for (const row of snapshot.parcels || []) {
    const parcel = {
      id: _int(row.id),
      orgId: String(row.org_id),
      holdId: row.hold_id ? String(row.hold_id) : null,
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

  return { holds, orgs, orgByBase, ranks, ranksByOrg, members, parcels, objectsByDesc, objectsById };
}

const EMPTY_INDEX = buildIndex();

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Rank|null} */
function memberRank(index, orgId, characterId) {
  if (!Number.isSafeInteger(characterId)) return null;
  const rankId = index.members.get(_key(orgId, characterId));
  return rankId == null ? null : (index.ranks.get(rankId) || null);
}

/** @returns {Rank|null} */
function findRank(index, orgId, rankKey) {
  if (typeof rankKey !== 'string') return null;
  const key = rankKey.trim().toLowerCase();
  return (index.ranksByOrg.get(orgId) || []).find((r) => r.key === key) || null;
}

function ranksOf(index, orgId) {
  return index.ranksByOrg.get(orgId) || [];
}

/** Org whose stone activator is this base FormDesc (`801:Oathbound_Holdstone.esp`), or null. */
function orgOfStone(index, baseDesc) {
  return typeof baseDesc === 'string' ? (index.orgByBase.get(baseDesc.toLowerCase()) || null) : null;
}

function parcelsOf(index, orgId) {
  return [...index.parcels.values()].filter((p) => p.orgId === orgId).sort((a, b) => a.id - b.id);
}

function objectsOf(index, parcelId) {
  return [...index.objectsByDesc.values()].filter((o) => o.parcelId === parcelId);
}

function membersOf(index, orgId) {
  const out = [];
  for (const [key, rankId] of index.members) {
    const sep = key.lastIndexOf(':');
    if (key.slice(0, sep) !== orgId) continue;
    const rank = index.ranks.get(rankId);
    if (rank) out.push({ characterId: Number(key.slice(sep + 1)), rank });
  }
  return out.sort((a, b) => (b.rank.position - a.rank.position) || (a.characterId - b.characterId));
}

/** Every organization this character belongs to, with their rank. */
function membershipsOf(index, characterId) {
  const out = [];
  if (!Number.isSafeInteger(characterId)) return out;
  for (const org of index.orgs.values()) {
    const rank = memberRank(index, org.id, characterId);
    if (rank) out.push({ org, rank });
  }
  return out.sort((a, b) => a.org.name.localeCompare(b.org.name));
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this character open the doors/containers of `parcel`?
 *
 * Order: unlocked parcel → staff → owner → rank at or above the minimum in
 * the parcel's organization. A parcel with no minimum rank is owner + staff only.
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
    const mine = memberRank(index, parcel.orgId, actor.characterId);
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

/** Parents of an organization, nearest first (Riverwood → [Whiterun]). Cycles stop. */
function ancestorsOf(index, orgId) {
  const out = [];
  const seen = new Set([orgId]);
  const orgs = index.orgs || new Map();
  let org = orgs.get(orgId);
  while (org && org.parentId && !seen.has(org.parentId)) {
    seen.add(org.parentId);
    const parent = orgs.get(org.parentId);
    if (!parent) break;
    out.push(parent);
    org = parent;
  }
  return out;
}

/** Organizations that answer directly to this one. */
function childrenOf(index, orgId) {
  return [...(index.orgs || new Map()).values()].filter((o) => o.parentId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}

/** Leader of a parent (or grandparent…) organization: leads this one too. */
function leadsFromParent(index, orgId, actor) {
  return ancestorsOf(index, orgId).some((parent) => {
    const rank = memberRank(index, parent.id, actor.characterId);
    return Boolean(rank && rank.isLeader);
  });
}

/** Leader of the organization (a member whose rank is a leader rank), leader of a parent, or staff. */
function canManageOrg(index, orgId, actor) {
  if (actor.isStaff) return true;
  const rank = memberRank(index, orgId, actor.characterId);
  if (rank && rank.isLeader) return true;
  return leadsFromParent(index, orgId, actor);
}

/** Owners may lock/unlock their own parcel; leaders and staff any of the organization's. */
function canLockParcel(index, parcel, actor) {
  if (canManageOrg(index, parcel.orgId, actor)) return true;
  return parcel.ownerCharacterId != null && actor.characterId === parcel.ownerCharacterId;
}

/**
 * May `actor` move `targetCharacterId` to `newRank` (null = remove)?
 * Staff: always. Leaders of a parent organization: any rank, anyone but
 * themselves. Leaders: only below their own rank, and only for members
 * currently below them — a Steward cannot crown a Jarl or demote one.
 *
 * @returns {{ok:true}|{ok:false, message:string}}
 */
function canAssignRank(index, orgId, actor, targetCharacterId, newRank) {
  if (actor.isStaff) return { ok: true };
  // A parent's leader stands above the child's whole ladder (the Jarl of
  // Whiterun can name Riverwood's Reeve), but still not over their own rank.
  if (leadsFromParent(index, orgId, actor)) {
    if (targetCharacterId === actor.characterId) return { ok: false, message: 'You cannot change your own rank.' };
    return { ok: true };
  }
  const mine = memberRank(index, orgId, actor.characterId);
  if (!mine || !mine.isLeader) return { ok: false, message: 'Only the leaders here can set ranks.' };
  if (targetCharacterId === actor.characterId) return { ok: false, message: 'You cannot change your own rank.' };
  const theirs = memberRank(index, orgId, targetCharacterId);
  if (theirs && theirs.position >= mine.position) {
    return { ok: false, message: `${theirs.name} is not below your rank; only staff or a higher rank can change it.` };
  }
  if (newRank && newRank.position >= mine.position) {
    return { ok: false, message: `You can only grant ranks below ${mine.name}.` };
  }
  return { ok: true };
}

module.exports = {
  ORG_KINDS,
  DEFAULT_LADDERS,
  EMPTY_INDEX,
  buildIndex,
  memberRank,
  findRank,
  ranksOf,
  orgOfStone,
  parcelsOf,
  objectsOf,
  membersOf,
  membershipsOf,
  ancestorsOf,
  childrenOf,
  leadsFromParent,
  canOpenParcel,
  checkActivation,
  canManageOrg,
  canLockParcel,
  canAssignRank
};
