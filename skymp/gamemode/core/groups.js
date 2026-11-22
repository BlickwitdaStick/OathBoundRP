/**
 * core/groups.js — player groups (parties), in memory
 *
 * Pure: no `mp`, no database. A group lives while its members are online;
 * logging out leaves the group. Looking at someone and pressing G
 * (look-keys-service.js) either invites them or, when they already invited
 * you, joins their group.
 */

'use strict';

const MAX_MEMBERS = 8;
const INVITE_TTL_MS = 2 * 60 * 1000;

function createGroups({ now = Date.now } = {}) {
  /** groupId -> Set<actorId> */
  const groups = new Map();
  /** actorId -> groupId */
  const groupOf = new Map();
  /** invitee actorId -> Map<inviter actorId, expiresAt> */
  const invites = new Map();
  let nextId = 1;

  function membersOf(actorId) {
    const id = groupOf.get(actorId);
    return id ? [...groups.get(id)] : [];
  }

  function sameGroup(a, b) {
    const ga = groupOf.get(a);
    return Boolean(ga) && ga === groupOf.get(b);
  }

  function hasInvite(invitee, inviter) {
    const m = invites.get(invitee);
    const exp = m && m.get(inviter);
    if (!exp) return false;
    if (exp < now()) { m.delete(inviter); return false; }
    return true;
  }

  function _join(actorId, groupId) {
    leave(actorId);
    groups.get(groupId).add(actorId);
    groupOf.set(actorId, groupId);
    invites.delete(actorId);
  }

  /**
   * G pressed by `actorId` while looking at `targetId`.
   * @returns {{result:'invited'|'joined'|'already'|'full', groupId?:number, members?:number[]}}
   */
  function pressGroup(actorId, targetId) {
    if (sameGroup(actorId, targetId)) return { result: 'already', members: membersOf(actorId) };

    if (hasInvite(actorId, targetId)) {
      let gid = groupOf.get(targetId);
      if (!gid) {
        gid = nextId++;
        groups.set(gid, new Set([targetId]));
        groupOf.set(targetId, gid);
      }
      if (groups.get(gid).size >= MAX_MEMBERS) return { result: 'full' };
      _join(actorId, gid);
      return { result: 'joined', groupId: gid, members: [...groups.get(gid)] };
    }

    const gid = groupOf.get(actorId);
    if (gid && groups.get(gid).size >= MAX_MEMBERS) return { result: 'full' };
    if (!invites.has(targetId)) invites.set(targetId, new Map());
    invites.get(targetId).set(actorId, now() + INVITE_TTL_MS);
    return { result: 'invited' };
  }

  /** @returns {number[]} who is left in the group the actor left */
  function leave(actorId) {
    const gid = groupOf.get(actorId);
    if (!gid) return [];
    const set = groups.get(gid);
    set.delete(actorId);
    groupOf.delete(actorId);
    const rest = [...set];
    if (set.size <= 1) {
      for (const m of set) groupOf.delete(m);
      groups.delete(gid);
    }
    return rest;
  }

  function forget(actorId) {
    const rest = leave(actorId);
    invites.delete(actorId);
    for (const m of invites.values()) m.delete(actorId);
    return rest;
  }

  function allGrouped() {
    return [...groupOf.keys()];
  }

  return { pressGroup, leave, forget, membersOf, sameGroup, hasInvite, allGrouped };
}

module.exports = { createGroups, MAX_MEMBERS, INVITE_TTL_MS };
