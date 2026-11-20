/**
 * npc-spawn-filter.test.js
 *
 * The classification runs on REAL record bytes: `core/fixtures/npc-records.json`
 * was written by `scripts/record-npc-fixtures.js` from the five masters
 * (Skyrim, Update, Dawnguard, HearthFires, Dragonborn) on 2026-11-19 — the
 * leveled bandit, wolf, Thalmor and hunter lists with every template, race and
 * faction they reach, plus a Dragonborn cultist to exercise DLC FormID mapping.
 * The fake `mp.lookupEspmRecordById` below returns them in the shape the server
 * returns (`{ record: { id, editorId, type, flags, fields: [{type, data:
 * Uint8Array}] }, toGlobalRecordId }`, see ScampServer::LookupEspmRecordById).
 *
 * Run with: node --test npc-spawn-filter.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

const fixture = require('./core/fixtures/npc-records.json');
const classifierLib = require('./core/npc-classifier');

const { VERDICT } = classifierLib;

// ── Recorded ids (from the fixture) ─────────────────────────────────────────
const LVL_BANDIT_MELEE = 0x0003decb;   // LvlBanditMelee1H → LCharBanditMelee1H
const LCHAR_BANDIT_MELEE = 0x00039cfc;
const LVL_WOLF = 0x000b83c1;
const LVL_THALMOR_MELEE = 0x0002b35e;
const LVL_HUNTER = 0x0004e50a;
const DLC2_CULTIST = 0x04035656;       // Dragonborn.esm is load index 4
const DLC2_CULTIST_FACTION = 0x04034fbc;
const BANDIT_FACTION = 0x0001bcc0;
const NORD_RACE = 0x00013746;

// ── Synthetic records, for cases Skyrim has no clean single sample of ───────
const SYN_MIXED_LIST = 0x00fff001;
const SYN_DUN_BANDIT_FACTION = 0x00fff002;
const SYN_BANDIT_FRIEND_FACTION = 0x00fff003;
const SYN_NPC_DUN_BANDIT = 0x00fff004;
const SYN_NPC_BANDIT_FRIEND = 0x00fff005;
const SYN_NPC_BROKEN_RACE = 0x00fff006;

const key = (id) => '0x' + (id >>> 0).toString(16).padStart(8, '0');
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const acbs = (templateFlags) => {
  const b = new Array(24).fill(0);
  b[18] = templateFlags & 0xff; b[19] = (templateFlags >> 8) & 0xff;
  return b;
};
const lvlo = (formId) => [1, 0, 0, 0, ...le32(formId), 1, 0, 0, 0];

const SYNTHETIC = {
  [key(SYN_MIXED_LIST)]: { type: 'LVLN', editorId: 'TestMixedList', fields: [
    { type: 'LVLO', data: lvlo(LVL_BANDIT_MELEE) },
    { type: 'LVLO', data: lvlo(LVL_THALMOR_MELEE) }
  ] },
  [key(SYN_DUN_BANDIT_FACTION)]: { type: 'FACT', editorId: 'dunTestCaveBanditFaction', fields: [] },
  [key(SYN_BANDIT_FRIEND_FACTION)]: { type: 'FACT', editorId: 'BanditFriendFaction', fields: [] },
  [key(SYN_NPC_DUN_BANDIT)]: { type: 'NPC_', editorId: 'TestDunBandit', fields: [
    { type: 'ACBS', data: acbs(0) }, { type: 'RNAM', data: le32(NORD_RACE) },
    { type: 'SNAM', data: [...le32(SYN_DUN_BANDIT_FACTION), 0, 0, 0, 0] }
  ] },
  [key(SYN_NPC_BANDIT_FRIEND)]: { type: 'NPC_', editorId: 'TestBanditFriend', fields: [
    { type: 'ACBS', data: acbs(0) }, { type: 'RNAM', data: le32(NORD_RACE) },
    { type: 'SNAM', data: [...le32(SYN_BANDIT_FRIEND_FACTION), 0, 0, 0, 0] }
  ] },
  [key(SYN_NPC_BROKEN_RACE)]: { type: 'NPC_', editorId: 'TestBrokenRace', fields: [
    { type: 'ACBS', data: acbs(0) }, { type: 'RNAM', data: le32(0x00abcdef) }
  ] }
};

/** `mp.lookupEspmRecordById` over the fixture. */
function fixtureLookup(id) {
  const k = key(id);
  const syn = SYNTHETIC[k];
  if (syn) {
    return {
      record: { id: id >>> 0, editorId: syn.editorId, type: syn.type, flags: 0,
        fields: syn.fields.map(f => ({ type: f.type, data: Uint8Array.from(f.data) })) },
      toGlobalRecordId: (l) => l >>> 0
    };
  }
  const r = fixture.records[k];
  if (!r) return {}; // what the server returns for "no such record"
  const masterMap = fixture.masterMaps[r.plugin];
  return {
    record: { id: id >>> 0, editorId: r.editorId, type: r.type, flags: 0,
      fields: r.fields.map(f => ({ type: f.type, data: Uint8Array.from(Buffer.from(f.hex, 'hex')) })) },
    fileIndex: fixture.loadOrder.indexOf(r.plugin),
    toGlobalRecordId: (l) => (((masterMap[l >>> 24] ?? masterMap[masterMap.length - 1]) << 24) | (l & 0xffffff)) >>> 0
  };
}

/**
 * What `mp.get(actor, 'templateChain')` holds: LeveledListUtils::
 * EvaluateTemplateChain walks TPLT links, and for a leveled list pushes the NPC
 * it rolled. Here the roll is always the list's first entry.
 */
function serverChain(headId) {
  const chain = [];
  let next = headId;
  while (next && chain.length < 16) {
    const res = fixtureLookup(next);
    if (!res.record) break;
    if (res.record.type === 'LVLN') {
      next = classifierLib._readLeveledEntries(res)[0];
      continue;
    }
    chain.push(next);
    next = classifierLib._readNpc(res).template;
  }
  return chain;
}

function makeClassifier(extra = {}) {
  return classifierLib.createClassifier(Object.assign({
    lookup: fixtureLookup,
    hostileFactionIds: [BANDIT_FACTION, DLC2_CULTIST_FACTION],
    hostileFactionEditorIdPatterns: [/Bandit/i, /Cultist/i],
    hostileFactionEditorIdExclusions: [/Friend/i, /Ally/i]
  }, extra));
}

// ─────────────────────────────────────────────────────────────────────────────
describe('npc-classifier — recorded Skyrim data', () => {
  it('a leveled bandit is hostile in every outcome of its leveled list', () => {
    const r = makeClassifier().classifyBase(LVL_BANDIT_MELEE);
    assert.strictEqual(r.verdict, VERDICT.HOSTILE);
    assert.strictEqual(r.faction, BANDIT_FACTION);
    assert.ok(r.outcomes > 10, `expected many leveled outcomes, got ${r.outcomes}`);
  });

  it('a wolf is kept as a creature (WolfRace has no ActorTypeNPC keyword)', () => {
    assert.strictEqual(makeClassifier().classifyBase(LVL_WOLF).verdict, VERDICT.CREATURE);
  });

  it('Thalmor patrols and hunters are peaceful people and get removed', () => {
    const c = makeClassifier();
    assert.strictEqual(c.classifyBase(LVL_THALMOR_MELEE).verdict, VERDICT.PEACEFUL);
    assert.strictEqual(c.classifyBase(LVL_HUNTER).verdict, VERDICT.PEACEFUL);
    assert.ok(classifierLib.shouldRemoveVerdict(VERDICT.PEACEFUL));
  });

  it('a DLC record names its factions by file-local id, mapped through toGlobalRecordId', () => {
    const r = makeClassifier({ hostileFactionEditorIdPatterns: [] }).classifyBase(DLC2_CULTIST);
    assert.strictEqual(r.verdict, VERDICT.HOSTILE);
    assert.strictEqual(r.faction, DLC2_CULTIST_FACTION);
  });

  it('every playable race in the recording is a person race', () => {
    for (const [k, rec] of Object.entries(fixture.records)) {
      if (rec.type !== 'RACE') continue;
      const isPerson = classifierLib._readRaceIsPerson(fixtureLookup(Number(k)));
      assert.strictEqual(isPerson, /Race$/.test(rec.editorId) && !/Wolf|Fox/.test(rec.editorId), rec.editorId);
    }
  });

  it('a server-resolved template chain is used as-is (the NPC that actually spawned)', () => {
    const c = makeClassifier();
    const banditChain = serverChain(LVL_BANDIT_MELEE);
    assert.ok(banditChain.length >= 2, 'the bandit chain goes through its leveled list');
    // LCharBanditMelee1H nests further lists; whatever NPC it rolls is a bandit.
    assert.strictEqual(classifierLib._readNpc(fixtureLookup(LVL_BANDIT_MELEE)).template, LCHAR_BANDIT_MELEE);
    assert.strictEqual(c.classifyChain(banditChain).verdict, VERDICT.HOSTILE);
    assert.strictEqual(c.classifyChain(serverChain(LVL_THALMOR_MELEE)).verdict, VERDICT.PEACEFUL);
    assert.strictEqual(c.classifyChain(serverChain(LVL_WOLF)).verdict, VERDICT.CREATURE);
  });

  it('a template whose leveled list was not resolved yet is unknown, never peaceful', () => {
    // Chain stops at the head: race comes from a template the chain does not have.
    assert.strictEqual(makeClassifier().classifyChain([LVL_BANDIT_MELEE]).verdict, VERDICT.UNKNOWN);
  });
});

describe('npc-classifier — edge cases', () => {
  it('a leveled list that can roll a bandit or a Thalmor is mixed, kept by default', () => {
    // A bare LVLN head is expanded the same way as an NPC_ that templates one.
    const r = makeClassifier().classifyBase(SYN_MIXED_LIST);
    assert.strictEqual(r.verdict, VERDICT.MIXED);
    assert.strictEqual(classifierLib.shouldRemoveVerdict(VERDICT.MIXED), false);
    assert.strictEqual(classifierLib.shouldRemoveVerdict(VERDICT.MIXED, { removeMixed: true }), true);
  });

  it('dungeon copies of bandit factions match by editorId; BanditFriendFaction does not', () => {
    const c = makeClassifier({ hostileFactionIds: [] });
    assert.strictEqual(c.classifyBase(SYN_NPC_DUN_BANDIT).verdict, VERDICT.HOSTILE);
    assert.strictEqual(c.classifyBase(SYN_NPC_BANDIT_FRIEND).verdict, VERDICT.PEACEFUL);
  });

  it('unreadable race, missing record or a throwing API is unknown, and unknown is never removed', () => {
    const c = makeClassifier();
    assert.strictEqual(c.classifyBase(SYN_NPC_BROKEN_RACE).verdict, VERDICT.UNKNOWN);
    assert.strictEqual(c.classifyBase(0x00eeeeee).verdict, VERDICT.UNKNOWN);
    const throwing = classifierLib.createClassifier({ lookup: () => { throw new Error('boom'); }, hostileFactionIds: [] });
    assert.strictEqual(throwing.classifyBase(LVL_THALMOR_MELEE).verdict, VERDICT.UNKNOWN);
    assert.strictEqual(classifierLib.shouldRemoveVerdict(VERDICT.UNKNOWN), false);
    assert.strictEqual(classifierLib.shouldRemoveVerdict(VERDICT.CREATURE), false);
    assert.strictEqual(classifierLib.shouldRemoveVerdict(VERDICT.HOSTILE), false);
  });

  it('field data survives a JSON round-trip ({0: b0, 1: b1, ...})', () => {
    const bytes = classifierLib._toBytes(JSON.parse(JSON.stringify(Uint8Array.from([1, 2, 3]))));
    assert.deepStrictEqual(Array.from(bytes), [1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The service, against a fake world
// ─────────────────────────────────────────────────────────────────────────────

const PLAYER = 0xff000010;
const NPC_THALMOR_FAR = 0x000a0001;
const NPC_THALMOR_NEAR = 0x000a0002;
const NPC_BANDIT = 0x000a0003;
const NPC_WOLF = 0x000a0004;
const NPC_UNKNOWN = 0x000a0005;
const NPC_LATE = 0x000a0006;
const CREATED_BY_SERVER = 0xff0000aa;
const CELL = '1a26f:Skyrim.esm';

const world = new Map();
const writes = [];
let online = [];
let neighbours = [];

const originalMp = global.mp;
global.mp = {
  lookupEspmRecordById: fixtureLookup,
  getIdFromDesc: (desc) => {
    const [h, plugin] = String(desc).split(':');
    const idx = fixture.loadOrder.indexOf(plugin);
    if (idx < 0) throw new Error('plugin not loaded');
    return ((idx << 24) | parseInt(h, 16)) >>> 0;
  },
  get: (formId, prop) => {
    if (formId === 0 && prop === 'onlinePlayers') return online.slice();
    if (prop === 'actorNeighbors') return neighbours.slice();
    const f = world.get(formId);
    if (!f) throw new Error('form not found');
    return f[prop];
  },
  set: (formId, prop, value) => {
    writes.push({ formId, prop, value });
    const f = world.get(formId);
    if (f) f[prop] = value;
  }
};

after(() => {
  if (originalMp === undefined) delete global.mp;
  else global.mp = originalMp;
});

const filterLib = require('./npc-spawn-filter');

const at = (x) => ({ pos: [x, 0, 0], cellOrWorldDesc: CELL });
function npc(baseId, x, extra = {}) {
  return Object.assign({ baseDesc: `${(baseId & 0xffffff).toString(16)}:${fixture.loadOrder[baseId >>> 24]}`,
    templateChain: [], profileId: -1, isDisabled: false, locationalData: at(x) }, extra);
}

function resetWorld() {
  world.clear();
  writes.length = 0;
  world.set(PLAYER, { profileId: 7, locationalData: at(0), isDisabled: false });
  world.set(CREATED_BY_SERVER, npc(LVL_THALMOR_MELEE, 9000));
  world.set(NPC_THALMOR_FAR, npc(LVL_THALMOR_MELEE, 9000));
  world.set(NPC_THALMOR_NEAR, npc(LVL_HUNTER, 1000));
  world.set(NPC_BANDIT, npc(LVL_BANDIT_MELEE, 800));
  world.set(NPC_WOLF, npc(LVL_WOLF, 9000));
  world.set(NPC_UNKNOWN, npc(0x00eeeeee, 9000, { baseDesc: 'eeeeee:Skyrim.esm' }));
  online = [PLAYER];
  neighbours = [PLAYER, NPC_THALMOR_FAR, NPC_THALMOR_NEAR, NPC_BANDIT, NPC_WOLF, NPC_UNKNOWN, CREATED_BY_SERVER];
}

const config = (raw = {}) => filterLib.loadConfig(Object.assign({ safeRadius: 5000 }, raw));
const disabledIds = () => writes.filter(w => w.prop === 'isDisabled' && w.value === true).map(w => w.formId);

describe('npc-spawn-filter — sweep', () => {
  beforeEach(resetWorld);

  it('disables a far peaceful NPC; keeps bandits, wolves and anything unreadable', () => {
    const f = filterLib.createSpawnFilter(config());
    const r = f.sweepOnce();
    assert.deepStrictEqual(disabledIds(), [NPC_THALMOR_FAR]);
    assert.strictEqual(world.get(NPC_BANDIT).isDisabled, false);
    assert.strictEqual(world.get(NPC_WOLF).isDisabled, false);
    assert.strictEqual(world.get(NPC_UNKNOWN).isDisabled, false);
    assert.strictEqual(r.unknown, 1);
    assert.strictEqual(r.pending, 1); // the hunter at 1000 units
  });

  it('never touches player characters or forms the server created', () => {
    const f = filterLib.createSpawnFilter(config());
    f.sweepOnce();
    assert.ok(!writes.some(w => w.formId === PLAYER || w.formId === CREATED_BY_SERVER));
  });

  it('a peaceful NPC inside the safe radius waits, and goes once the player has left the cell', () => {
    const f = filterLib.createSpawnFilter(config());
    f.sweepOnce();
    assert.strictEqual(world.get(NPC_THALMOR_NEAR).isDisabled, false);

    // Player walks out: another cell, and the NPC is no longer a neighbour.
    world.get(PLAYER).locationalData = { pos: [0, 0, 0], cellOrWorldDesc: '3c:Skyrim.esm' };
    neighbours = [PLAYER];
    f.sweepOnce();
    assert.strictEqual(world.get(NPC_THALMOR_NEAR).isDisabled, true);
    assert.strictEqual(f._pending.size, 0);
  });

  it('only ever writes isDisabled=true — no delete, no other property', () => {
    const f = filterLib.createSpawnFilter(config());
    f.sweepOnce();
    neighbours = [PLAYER];
    world.get(PLAYER).locationalData = at(50000);
    f.sweepOnce();
    assert.ok(writes.length > 0);
    assert.ok(writes.every(w => w.prop === 'isDisabled' && w.value === true));
    assert.strictEqual(typeof global.mp.callPapyrusFunction, 'undefined');
  });

  it('decides each actor once', () => {
    const f = filterLib.createSpawnFilter(config());
    f.sweepOnce();
    const examined = f.stats.examined;
    f.sweepOnce();
    assert.strictEqual(f.stats.examined, examined);
  });

  it('uses the server-resolved template chain when there is one', () => {
    // Base says "bandit leveled list", resolved chain says Thalmor: the chain wins.
    world.get(NPC_BANDIT).templateChain = serverChain(LVL_THALMOR_MELEE);
    world.get(NPC_BANDIT).locationalData = at(9000);
    const f = filterLib.createSpawnFilter(config());
    assert.strictEqual(f.classifyActor(NPC_BANDIT).verdict, VERDICT.PEACEFUL);
  });

  it('disableOnFirstSight removes a peaceful NPC that streams in next to a player', () => {
    const f = filterLib.createSpawnFilter(config({ disableOnFirstSight: true }));
    f.sweepOnce(); // first sweep: everything already there respects the radius
    assert.strictEqual(world.get(NPC_THALMOR_NEAR).isDisabled, false);

    world.set(NPC_LATE, npc(LVL_THALMOR_MELEE, 300));
    neighbours.push(NPC_LATE);
    f.sweepOnce();
    assert.strictEqual(world.get(NPC_LATE).isDisabled, true);
  });

  it('alwaysKeep / alwaysRemove overrides beat the classifier', () => {
    const f = filterLib.createSpawnFilter(config({
      alwaysKeepBaseDescs: [world.get(NPC_THALMOR_FAR).baseDesc],
      alwaysRemoveBaseDescs: [world.get(NPC_WOLF).baseDesc]
    }));
    f.sweepOnce();
    assert.strictEqual(world.get(NPC_THALMOR_FAR).isDisabled, false);
    assert.strictEqual(world.get(NPC_WOLF).isDisabled, true);
  });

  it('restore re-enables one actor and the filter leaves it alone afterwards', () => {
    const f = filterLib.createSpawnFilter(config());
    f.sweepOnce();
    f.restore(NPC_THALMOR_FAR);
    assert.strictEqual(world.get(NPC_THALMOR_FAR).isDisabled, false);
    f.sweepOnce();
    assert.strictEqual(world.get(NPC_THALMOR_FAR).isDisabled, false);
  });

  it('a faction from a plugin that is not loaded is reported, not fatal', () => {
    const f = filterLib.createSpawnFilter(config({ extraHostileFactionDescs: ['800:NotLoaded.esp'] }));
    assert.deepStrictEqual(f.unresolvedFactions, ['800:NotLoaded.esp']);
    assert.strictEqual(f.hostileFactionCount, filterLib.DEFAULT_HOSTILE_FACTIONS.length);
  });
});

describe('npc-spawn-filter — config', () => {
  it('rejects radii and intervals that would make the filter lie', () => {
    assert.strictEqual(filterLib.loadConfig({ safeRadius: Infinity }).safeRadius, 5000);
    assert.strictEqual(filterLib.loadConfig({ safeRadius: 'abc' }).safeRadius, 5000);
    assert.strictEqual(filterLib.loadConfig({ safeRadius: -1 }).safeRadius, 5000);
    assert.strictEqual(filterLib.loadConfig({ sweepIntervalMs: 10 }).sweepIntervalMs, 2000);
    assert.strictEqual(filterLib.loadConfig({ safeRadius: 0 }).safeRadius, 0);
  });

  it('defaults are conservative: safe radius on, mixed lists kept, no first-sight removal', () => {
    const c = filterLib.loadConfig({});
    assert.strictEqual(c.disableOnFirstSight, false);
    assert.strictEqual(c.removeMixedLeveledLists, false);
    assert.ok(c.hostileFactionDescs.includes('1bcc0:Skyrim.esm'));
  });
});
