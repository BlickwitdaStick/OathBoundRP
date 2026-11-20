'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const locks = require('./parcel-locks');

const DESC_IDS = {
  'a1:Skyrim.esm': 0xa1,       // front door (locks)
  'a2:Skyrim.esm': 0xa2,       // interior side (exit)
  'c1:Skyrim.esm': 0xc1,       // chest
  'b0:Skyrim.esm': 0xb0,       // holdstone
  'd1:Skyrim.esm': 0xd1        // door of an unlocked parcel
};

function snapshot(overrides = {}) {
  return {
    holds: [{ id: 'whiterun', name: 'Whiterun' }, { id: 'riften', name: 'Riften' }],
    holdstones: [{ hold_id: 'whiterun', object_id: 'b0:Skyrim.esm' }],
    ranks: [
      { id: 1, hold_id: 'whiterun', rank_key: 'citizen', name: 'Citizen', position: 10, is_leader: 0 },
      { id: 2, hold_id: 'whiterun', rank_key: 'guard', name: 'Guard', position: 20, is_leader: 0 },
      { id: 3, hold_id: 'whiterun', rank_key: 'steward', name: 'Steward', position: 30, is_leader: 1 },
      { id: 4, hold_id: 'whiterun', rank_key: 'jarl', name: 'Jarl', position: 40, is_leader: 1 },
      { id: 5, hold_id: 'riften', rank_key: 'jarl', name: 'Jarl', position: 40, is_leader: 1 }
    ],
    members: [
      { hold_id: 'whiterun', character_id: 10, rank_id: 1 }, // citizen
      { hold_id: 'whiterun', character_id: 20, rank_id: 2 }, // guard
      { hold_id: 'whiterun', character_id: 30, rank_id: 3 }, // steward
      { hold_id: 'whiterun', character_id: 40, rank_id: 4 }, // jarl
      { hold_id: 'riften', character_id: 50, rank_id: 5 }    // jarl of another hold
    ],
    parcels: [
      { id: 100, hold_id: 'whiterun', name: 'Barracks', owner_character_id: 99, min_rank_id: 2, locked: 1 },
      { id: 101, hold_id: 'whiterun', name: 'Private house', owner_character_id: 77, min_rank_id: null, locked: 1 },
      { id: 102, hold_id: 'whiterun', name: 'Open shop', owner_character_id: 77, min_rank_id: null, locked: 0 }
    ],
    objects: [
      { object_id: 'a1:Skyrim.esm', parcel_id: 100, kind: 'door', locks: 1, partner_object_id: 'a2:Skyrim.esm' },
      { object_id: 'a2:Skyrim.esm', parcel_id: 100, kind: 'door', locks: 0, partner_object_id: 'a1:Skyrim.esm' },
      { object_id: 'c1:Skyrim.esm', parcel_id: 101, kind: 'container', locks: 1 },
      { object_id: 'd1:Skyrim.esm', parcel_id: 102, kind: 'door', locks: 1 }
    ],
    ...overrides
  };
}

const index = locks.buildIndex(snapshot(), (desc) => DESC_IDS[desc] || null);
const as = (characterId, isStaff = false) => ({ characterId, isStaff });

describe('parcel-locks: permission resolution', () => {
  it('an object outside any parcel is not locked', () => {
    const verdict = locks.checkActivation(index, 0xdead, as(1));
    assert.equal(verdict.known, false);
    assert.equal(verdict.allowed, true);
  });

  it('the owner opens their parcel even without rank', () => {
    assert.equal(locks.checkActivation(index, 0xa1, as(99)).reason, 'owner');
    assert.equal(locks.checkActivation(index, 0xc1, as(77)).allowed, true);
  });

  it('rank ladder: at or above the minimum opens, below does not', () => {
    assert.equal(locks.checkActivation(index, 0xa1, as(10)).allowed, false, 'citizen < guard');
    assert.equal(locks.checkActivation(index, 0xa1, as(20)).reason, 'rank', 'guard = guard');
    assert.equal(locks.checkActivation(index, 0xa1, as(30)).allowed, true, 'steward > guard');
    assert.equal(locks.checkActivation(index, 0xa1, as(40)).allowed, true, 'jarl > guard');
  });

  it('rank in another hold does not count', () => {
    assert.equal(locks.checkActivation(index, 0xa1, as(50)).allowed, false);
  });

  it('no minimum rank means owner and staff only, even for the jarl', () => {
    assert.equal(locks.checkActivation(index, 0xc1, as(40)).allowed, false);
  });

  it('staff override opens everything', () => {
    assert.equal(locks.checkActivation(index, 0xc1, as(1, true)).reason, 'staff');
    assert.equal(locks.checkActivation(index, 0xa1, as(null, true)).allowed, true);
  });

  it('an unlocked parcel opens for anyone', () => {
    assert.equal(locks.checkActivation(index, 0xd1, as(1)).reason, 'unlocked');
  });

  it('the exit side of a load door never blocks', () => {
    const verdict = locks.checkActivation(index, 0xa2, as(1));
    assert.equal(verdict.known, true);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'exit');
  });

  it('a character with no data is denied on a locked object', () => {
    assert.equal(locks.checkActivation(index, 0xa1, as(null)).allowed, false);
  });

  it('objects whose FormDesc does not resolve are kept by desc but not by id', () => {
    const idx = locks.buildIndex(snapshot(), () => null);
    assert.equal(idx.objectsById.size, 0);
    assert.equal(idx.objectsByDesc.size, 4);
    assert.equal(locks.checkActivation(idx, 0xa1, as(1)).known, false);
  });

  it('a throwing resolver does not break the index', () => {
    const idx = locks.buildIndex(snapshot(), () => { throw new Error('no mp'); });
    assert.equal(idx.parcels.size, 3);
  });
});

describe('parcel-locks: leadership', () => {
  it('leaders and staff manage the hold; others do not', () => {
    assert.equal(locks.canManageHold(index, 'whiterun', as(30)), true);
    assert.equal(locks.canManageHold(index, 'whiterun', as(20)), false);
    assert.equal(locks.canManageHold(index, 'whiterun', as(50)), false, 'jarl of riften');
    assert.equal(locks.canManageHold(index, 'whiterun', as(1, true)), true);
  });

  it('owners may lock their own parcel', () => {
    const house = index.parcels.get(101);
    assert.equal(locks.canLockParcel(index, house, as(77)), true);
    assert.equal(locks.canLockParcel(index, house, as(10)), false);
  });

  it('leaders grant only ranks below their own, to members below them', () => {
    const guard = locks.findRank(index, 'whiterun', 'guard');
    const steward = locks.findRank(index, 'whiterun', 'steward');
    const jarl = locks.findRank(index, 'whiterun', 'jarl');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(30), 10, guard).ok, true);
    assert.equal(locks.canAssignRank(index, 'whiterun', as(30), 10, steward).ok, false, 'not equal rank');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(30), 40, null).ok, false, 'cannot demote the jarl');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(30), 30, null).ok, false, 'not yourself');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(40), 30, null).ok, true, 'jarl removes steward');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(20), 10, guard).ok, false, 'guard is not a leader');
    assert.equal(locks.canAssignRank(index, 'whiterun', as(1, true), 99, jarl).ok, true, 'staff');
  });

  it('ranks are ordered and found by key, case-insensitively', () => {
    assert.deepEqual(locks.ranksOf(index, 'whiterun').map((r) => r.key), ['citizen', 'guard', 'steward', 'jarl']);
    assert.equal(locks.findRank(index, 'whiterun', ' Guard ').id, 2);
    assert.equal(locks.findRank(index, 'riften', 'guard'), null);
  });

  it('membersOf lists the hold, highest rank first; holdOfStone resolves the stone', () => {
    assert.deepEqual(locks.membersOf(index, 'whiterun').map((m) => m.characterId), [40, 30, 20, 10]);
    assert.equal(locks.holdOfStone(index, 0xb0), 'whiterun');
    assert.equal(locks.holdOfStone(index, 0xa1), null);
  });
});
