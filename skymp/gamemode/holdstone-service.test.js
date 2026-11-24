'use strict';

/**
 * holdstone-service: stones known by their activator (placed in the Creation
 * Kit, nothing bound in game), organizations synced from holdstones.json,
 * activation blocking, parcel assignment, ranks and the parceling tool —
 * against an in-memory fake of the v33/v41 tables and a fake `mp`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, it, beforeEach, afterEach } = require('node:test');

const service = require('./holdstone-service');
const activationEvents = require('./core/activation-events');
const interactionRegistry = require('./core/interaction-registry');
const espm = require('./core/espm');

// ── fake world ──────────────────────────────────────────────────────────────
const FRONT_DOOR = 0xa1;
const INSIDE_DOOR = 0xa2;
const CHEST = 0xc1;
const ROCK = 0xe1;
const WHITERUN_STONE = 0xb1;   // a placed "Whiterun Holdstone"
const WHITERUN_STONE_2 = 0xb2; // a second Whiterun stone elsewhere
const HROTHGAR_STONE = 0xb3;   // a placed "High Hrothgar Holdstone"
const GENERIC_STONE = 0xb9;    // the old generic "Holdstone" (800)
const DOOR_BASE = 0x1000;
const CHEST_BASE = 0x2000;
const ROCK_BASE = 0x3000;
const PLUGIN = 'Oathbound_Holdstone.esp';
const BASE_DESC_OF = {
  [FRONT_DOOR]: '1000:Skyrim.esm',
  [INSIDE_DOOR]: '1000:Skyrim.esm',
  [CHEST]: '2000:Skyrim.esm',
  [ROCK]: '3000:Skyrim.esm',
  [WHITERUN_STONE]: `801:${PLUGIN}`,
  [WHITERUN_STONE_2]: `801:${PLUGIN}`,
  [HROTHGAR_STONE]: `80B:${PLUGIN}`,
  [GENERIC_STONE]: `800:${PLUGIN}`
};

const STONES = {
  plugin: PLUGIN,
  stones: [
    { id: 'whiterun', name: 'Whiterun', kind: 'hold', hold: 'whiterun', formId: '801' },
    { id: 'riverwood', name: 'Riverwood', kind: 'town', hold: 'whiterun', formId: '80a', parent: 'whiterun' },
    { id: 'high_hrothgar', name: 'High Hrothgar', kind: 'faction', hold: null, formId: '80b' },
    { id: 'imperial_legion', name: 'Imperial Legion', kind: 'faction', hold: 'solitude', formId: '80c' }
  ]
};

function installMp() {
  global.mp = {
    getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
    getIdFromDesc: (desc) => parseInt(desc.split(':')[0], 16),
    get: (id, prop) => (prop === 'baseDesc' ? BASE_DESC_OF[id] : undefined),
    lookupEspmRecordById: (id) => {
      if (id === DOOR_BASE) return { record: { type: 'DOOR', editorId: 'HouseDoor', fields: [] } };
      if (id === CHEST_BASE) return { record: { type: 'CONT', editorId: 'Chest', fields: [] } };
      if (id === ROCK_BASE) return { record: { type: 'STAT', editorId: 'Rock', fields: [] } };
      if (id === FRONT_DOOR) {
        return { record: { type: 'REFR', fields: [{ type: 'XTEL', data: [INSIDE_DOOR, 0, 0, 0, 0, 0, 0, 0] }] } };
      }
      return {};
    }
  };
}

// ── fake database (only the statements holdstone-service issues) ────────────
function createDb() {
  const t = {
    holds: [{ id: 'whiterun', name: 'Whiterun Hold' }, { id: 'solitude', name: 'Haafingar' }, { id: 'riften', name: 'The Rift' }],
    // As migration v41 leaves them: holds copied from v33 with their ranks.
    stone_orgs: [
      { id: 'whiterun', name: 'Whiterun Hold', kind: 'hold', hold_id: 'whiterun', base_id: null },
      { id: 'riften', name: 'The Rift', kind: 'hold', hold_id: 'riften', base_id: null }
    ],
    stone_ranks: [
      { id: 1, org_id: 'whiterun', rank_key: 'citizen', name: 'Citizen', position: 10, is_leader: 0 },
      { id: 2, org_id: 'whiterun', rank_key: 'guard', name: 'Guard', position: 20, is_leader: 0 },
      { id: 3, org_id: 'whiterun', rank_key: 'steward', name: 'Steward', position: 30, is_leader: 1 },
      { id: 4, org_id: 'whiterun', rank_key: 'jarl', name: 'Jarl', position: 40, is_leader: 1 },
      { id: 5, org_id: 'riften', rank_key: 'citizen', name: 'Citizen', position: 10, is_leader: 0 }
    ],
    stone_members: [],
    parcels: [],
    parcel_objects: [],
    characters: [
      { id: 10, first_name: 'Ana', last_name: 'Stone', char_number: 1, status: 'approved' },
      { id: 20, first_name: 'Bo', last_name: 'Guard', char_number: 2, status: 'approved' },
      { id: 30, first_name: 'Cy', last_name: 'Steward', char_number: 3, status: 'approved' },
      { id: 40, first_name: 'Di', last_name: 'Jarl', char_number: 4, status: 'approved' }
    ]
  };
  let nextParcel = 1;
  let nextRank = 100;
  const sql = (s) => s.replace(/\s+/g, ' ').trim();

  async function query(raw, p = []) {
    const s = sql(raw);
    if (s === 'SELECT id FROM holds') return t.holds.map((h) => ({ id: h.id }));
    if (s.startsWith('SELECT id, name FROM holds')) return t.holds;
    if (s.startsWith('SELECT id, name, kind, hold_id, parent_id, base_id FROM stone_orgs')) return t.stone_orgs;
    if (s === 'SELECT id FROM stone_orgs') return t.stone_orgs.map((o) => ({ id: o.id }));
    if (s.startsWith('UPDATE stone_orgs SET parent_id')) {
      const row = t.stone_orgs.find((o) => o.id === p[1]);
      if (row) row.parent_id = p[0];
      return {};
    }
    if (s === 'SELECT id, kind FROM stone_orgs') return t.stone_orgs.map((o) => ({ id: o.id, kind: o.kind }));
    if (s === 'SELECT DISTINCT org_id FROM stone_ranks') return [...new Set(t.stone_ranks.map((r) => r.org_id))].map((org_id) => ({ org_id }));
    if (s.startsWith('SELECT id, org_id, rank_key')) return t.stone_ranks;
    if (s.startsWith('SELECT org_id, character_id, rank_id')) return t.stone_members;
    if (s.startsWith('SELECT id, org_id, hold_id, name, owner_character_id')) return t.parcels;
    if (s.startsWith('SELECT object_id, parcel_id')) return t.parcel_objects;
    if (s.includes('FROM characters WHERE char_number')) return t.characters.filter((c) => c.char_number === p[0]);
    if (s.includes('FROM characters WHERE id IN')) return t.characters.filter((c) => p.includes(c.id));

    if (s.startsWith('UPDATE stone_orgs SET base_id = NULL')) {
      for (const o of t.stone_orgs) if (o.base_id === p[0] && o.id !== p[1]) o.base_id = null;
      return {};
    }
    if (s.startsWith('INSERT INTO stone_orgs')) {
      const row = { id: p[0], name: p[1], kind: p[2], hold_id: p[3], base_id: p[4] };
      const existing = t.stone_orgs.find((o) => o.id === p[0]);
      if (existing) Object.assign(existing, row); else t.stone_orgs.push({ ...row, parent_id: null });
      return {};
    }
    if (s.startsWith('INSERT IGNORE INTO stone_ranks')) {
      if (!t.stone_ranks.some((r) => r.org_id === p[0] && r.rank_key === p[1])) {
        t.stone_ranks.push({ id: nextRank++, org_id: p[0], rank_key: p[1], name: p[2], position: p[3], is_leader: p[4] });
      }
      return {};
    }
    if (s.startsWith('INSERT INTO stone_ranks')) {
      const existing = t.stone_ranks.find((r) => r.org_id === p[0] && r.rank_key === p[1]);
      if (existing) Object.assign(existing, { name: p[2], position: p[3], is_leader: p[4] });
      else t.stone_ranks.push({ id: nextRank++, org_id: p[0], rank_key: p[1], name: p[2], position: p[3], is_leader: p[4] });
      return {};
    }
    if (s.startsWith('SELECT rank_key FROM stone_ranks WHERE org_id')) {
      return t.stone_ranks.filter((r) => r.org_id === p[0]).map((r) => ({ rank_key: r.rank_key })).sort((x, y) => x.rank_key.localeCompare(y.rank_key));
    }
    if (s.startsWith('SELECT COUNT(*) AS n FROM stone_members WHERE org_id')) {
      return [{ n: t.stone_members.filter((m) => m.org_id === p[0]).length }];
    }
    if (s === 'DELETE FROM stone_ranks WHERE org_id = ?') {
      t.stone_ranks = t.stone_ranks.filter((r) => r.org_id !== p[0]);
      return {};
    }
    if (s.startsWith('SELECT character_id, org_id FROM advisors')) return t.advisors || [];
    if (s.startsWith('SELECT character_id FROM advisors WHERE org_id')) return (t.advisors || []).filter((r) => r.org_id === p[0]);
    if (s.startsWith('DELETE FROM advisors WHERE org_id = ? OR character_id = ?')) {
      t.advisors = (t.advisors || []).filter((r) => r.org_id !== p[0] && r.character_id !== p[1]);
      return {};
    }
    if (s.startsWith('DELETE FROM advisors WHERE character_id')) {
      t.advisors = (t.advisors || []).filter((r) => r.character_id !== p[0]);
      return {};
    }
    if (s.startsWith('INSERT INTO advisors')) {
      (t.advisors = t.advisors || []).push({ character_id: p[0], org_id: p[1] });
      return {};
    }
    if (s.startsWith('DELETE FROM stone_ranks')) {
      t.stone_ranks = t.stone_ranks.filter((r) => r.id !== p[0]);
      t.stone_members = t.stone_members.filter((m) => m.rank_id !== p[0]);
      return {};
    }
    if (s.startsWith('DELETE FROM stone_members')) {
      t.stone_members = t.stone_members.filter((r) => !(r.org_id === p[0] && r.character_id === p[1]));
      return {};
    }
    if (s.startsWith('INSERT INTO stone_members')) {
      t.stone_members = t.stone_members.filter((r) => !(r.org_id === p[0] && r.character_id === p[1]))
        .concat({ org_id: p[0], character_id: p[1], rank_id: p[2] });
      return {};
    }
    if (s.startsWith('INSERT INTO parcels')) {
      const id = nextParcel++;
      t.parcels.push({ id, org_id: p[0], hold_id: p[1], name: p[2], owner_character_id: null, min_rank_id: p[3], locked: 1 });
      return { insertId: id };
    }
    const upd = s.match(/^UPDATE parcels SET (\w+) = \? WHERE id = \?$/);
    if (upd) {
      const row = t.parcels.find((r) => r.id === p[1]);
      if (row) row[upd[1]] = p[0];
      return {};
    }
    if (s.startsWith('DELETE FROM parcels')) {
      t.parcels = t.parcels.filter((r) => r.id !== p[0]);
      t.parcel_objects = t.parcel_objects.filter((r) => r.parcel_id !== p[0]);
      return {};
    }
    if (s.startsWith('INSERT INTO parcel_objects')) {
      const existing = t.parcel_objects.find((r) => r.object_id === p[0]);
      if (existing) Object.assign(existing, { kind: p[2], locks: 1, partner_object_id: p[3] || existing.partner_object_id });
      else t.parcel_objects.push({ object_id: p[0], parcel_id: p[1], kind: p[2], locks: 1, partner_object_id: p[3] });
      return {};
    }
    if (s.startsWith('INSERT IGNORE INTO parcel_objects')) {
      if (!t.parcel_objects.some((r) => r.object_id === p[0])) {
        t.parcel_objects.push({ object_id: p[0], parcel_id: p[1], kind: 'door', locks: 0, partner_object_id: p[2] });
      }
      return {};
    }
    if (s.startsWith('DELETE FROM parcel_objects')) {
      t.parcel_objects = t.parcel_objects.filter((r) => r.object_id !== p[0]);
      return {};
    }
    if (s.startsWith('UPDATE parcel_objects SET locks')) {
      const row = t.parcel_objects.find((r) => r.object_id === p[1]);
      if (row) row.locks = p[0];
      return {};
    }
    throw new Error(`fake db: unhandled SQL: ${s}`);
  }
  return { query, tables: t };
}

// ── fake players ────────────────────────────────────────────────────────────
// actorId → characterId. 0xff000001 is staff.
const PLAYERS = {
  0xff000001: { characterId: 1, firstName: 'Staff', lastName: 'Member' },
  0xff000010: { characterId: 10, firstName: 'Ana', lastName: 'Stone' },
  0xff000020: { characterId: 20, firstName: 'Bo', lastName: 'Guard' },
  0xff000030: { characterId: 30, firstName: 'Cy', lastName: 'Steward' },
  0xff000040: { characterId: 40, firstName: 'Di', lastName: 'Jarl' }
};
const STAFF = 0xff000001;
const ANA = 0xff000010;
const BO = 0xff000020;
const STAFF_ACTOR = { isStaff: true, characterId: 1 };

let db;
let notes;
let menus;
let modals;
let focus;
let errors;

function setup() {
  installMp();
  espm._limparCache();
  service._resetForTest();
  activationEvents._resetForTest();
  interactionRegistry._reset();
  db = createDb();
  notes = [];
  menus = [];
  modals = [];
  focus = [];
  errors = [];
  service.configure({
    db,
    commands: {
      getActiveCharacterData: (actorId) => PLAYERS[actorId] || null,
      getActiveActorByCharacterId: (characterId) => {
        const hit = Object.entries(PLAYERS).find(([, v]) => v.characterId === characterId);
        return hit ? Number(hit[0]) : null;
      },
      sendNotification: (actorId, message) => notes.push({ actorId, message })
    },
    isStaff: (actorId) => actorId === STAFF,
    sendModal: (actorId, type, data) => modals.push({ actorId, type, data }),
    setBrowserFocus: (actorId, focused) => focus.push({ actorId, focused }),
    openInteractionMenu: (actorId, targetId) => menus.push({ actorId, targetId }),
    stoneList: () => STONES,
    logger: { log() {}, error: (...a) => errors.push(a.join(' ')) }
  });
}

async function boot() {
  setup();
  await service.syncOrganizations();
  await service.reload();
}

const desc = (id) => `${id.toString(16)}:Skyrim.esm`;
const lastNote = (actorId) => [...notes].reverse().find((n) => n.actorId === actorId)?.message;
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

describe('holdstone-service: stones from holdstones.json', () => {
  beforeEach(boot);
  afterEach(() => { delete global.mp; });

  it('the shipped holdstones.json is valid: unique ids and formIds, known kinds', () => {
    const real = JSON.parse(fs.readFileSync(service.STONES_FILE, 'utf8'));
    assert.equal(real.plugin, 'Oathbound_Holdstone.esp');
    const ids = real.stones.map((s) => s.id);
    const forms = real.stones.map((s) => parseInt(s.formId, 16));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(forms).size, forms.length);
    assert.ok(forms.every((f) => f > 0x800 && f <= 0xfff), 'own records of a light plugin, 800 is the generic stone');
    for (const s of real.stones) assert.ok(['hold', 'town', 'faction', 'thanedom', 'council'].includes(s.kind), s.id);
    for (const id of ['whiterun', 'riverwood', 'high_hrothgar', 'imperial_legion', 'solitude']) assert.ok(ids.includes(id), id);
    const byId = Object.fromEntries(real.stones.map((s) => [s.id, s]));
    assert.equal(byId.high_hrothgar.kind, 'faction');
    assert.equal(byId.imperial_legion.kind, 'faction');
    assert.equal(byId.riverwood.parent, 'whiterun');
    assert.equal(byId.riverwood.kind, 'thanedom', 'Riverwood is a thanedom under Whiterun (RP Design)');
    for (const st of real.stones) if (st.parent) assert.ok(ids.includes(st.parent), `${st.id}: parent ${st.parent} exists`);
  });

  it('boot creates one organization per stone, keeps existing ranks, seeds ladders for new ones', () => {
    const orgs = Object.fromEntries(db.tables.stone_orgs.map((o) => [o.id, o]));
    assert.equal(orgs.whiterun.base_id, `801:${PLUGIN}`);
    assert.equal(orgs.whiterun.name, 'Whiterun', 'name comes from holdstones.json');
    assert.equal(orgs.high_hrothgar.kind, 'faction');
    assert.equal(orgs.riverwood.parent_id, 'whiterun');
    assert.equal(orgs.whiterun.parent_id, null);
    assert.equal(orgs.high_hrothgar.hold_id, null);
    assert.equal(orgs.riften.base_id, null, 'a hold with no stone in the list keeps none');
    const keys = (org) => db.tables.stone_ranks.filter((r) => r.org_id === org).map((r) => r.rank_key);
    // Whiterun had the old default ladder and nobody in it: it moves to the RP Design ladder.
    assert.deepEqual(keys('whiterun'), ['citizen', 'guard', 'quartermaster', 'court_mage', 'commander', 'sworn_sword', 'housecarl', 'steward', 'jarl']);
    assert.deepEqual(keys('high_hrothgar'), ['recruit', 'member', 'officer', 'leader']);
    assert.deepEqual(keys('riverwood'), ['resident', 'guard', 'reeve'], 'a town gets the town ladder');
    assert.deepEqual(keys('imperial_legion'), ['recruit', 'member', 'officer', 'leader']);
  });

  it('booting twice changes nothing', async () => {
    const before = JSON.stringify(db.tables);
    await service.syncOrganizations();
    assert.equal(JSON.stringify(db.tables), before);
  });

  it('a seat hold that does not exist is stored as none; bad entries are skipped', async () => {
    service.configure({ stoneList: () => ({ plugin: PLUGIN, stones: [
      { id: 'thane_x', name: 'Thanedom X', kind: 'thanedom', hold: 'atlantis', formId: '80d' },
      { id: 'Bad Id', name: 'Bad', kind: 'hold', hold: null, formId: '80e' },
      { id: 'nokind', name: 'No kind', kind: 'empire', hold: null, formId: '80f' }
    ] }) });
    await service.syncOrganizations();
    const thane = db.tables.stone_orgs.find((o) => o.id === 'thane_x');
    assert.equal(thane.hold_id, null);
    assert.equal(thane.kind, 'thanedom');
    assert.ok(!db.tables.stone_orgs.some((o) => o.id === 'nokind' || o.id === 'Bad Id'));
    assert.equal(errors.length, 2);
  });
});

describe('holdstone-service: a stone placed in the Creation Kit works without binding', () => {
  beforeEach(boot);
  afterEach(() => { delete global.mp; });

  it('E on any reference of an organization activator opens its menu', () => {
    assert.equal(service.orgOfStoneRef(WHITERUN_STONE), 'whiterun');
    assert.equal(service.orgOfStoneRef(WHITERUN_STONE_2), 'whiterun', 'two stones of one organization');
    assert.equal(service.orgOfStoneRef(HROTHGAR_STONE), 'high_hrothgar', 'hex case does not matter');
    assert.equal(service.handleActivation(HROTHGAR_STONE, ANA), false);
    assert.deepEqual(menus, [{ actorId: ANA, targetId: HROTHGAR_STONE }]);
  });

  it('the generic stone belongs to no one: E says so (and tells staff why) instead of doing nothing', () => {
    assert.equal(service.handleActivation(GENERIC_STONE, ANA), false);
    assert.match(lastNote(ANA), /belongs to no one/);
    service.handleActivation(GENERIC_STONE, STAFF);
    assert.match(lastNote(STAFF), /800:Oathbound_Holdstone\.esp\) is not in data\/holdstones\.json/);
    assert.deepEqual(menus, []);
  });

  it('the generic stone and ordinary objects are not stones', () => {
    assert.equal(service.orgOfStoneRef(GENERIC_STONE), null);
    assert.equal(service.orgOfStoneRef(ROCK), null);
    assert.equal(service.handleActivation(ROCK, ANA), undefined);
    assert.deepEqual(menus, []);
  });

  it('the stone menu: everyone sees it, only leaders see leadership actions', async () => {
    service.registerInteractions();
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 10, name: 'Ana' }, 'citizen');
    const ctx = { actorId: ANA, characterId: 10, target: { formId: WHITERUN_STONE }, data: {} };
    assert.equal(await interactionRegistry.get('holdstone.view').canSee(ctx), true);
    assert.equal(await interactionRegistry.get('holdstone.create_parcel').canSee(ctx), false);
    assert.equal(await interactionRegistry.get('holdstone.view').canSee({ ...ctx, target: { formId: ROCK } }), false);

    await interactionRegistry.get('holdstone.view').execute(ctx);
    const panel = modals.at(-1);
    assert.equal(panel.type, 'holdstone:open');
    assert.equal(panel.data.orgName, 'Whiterun');
    assert.equal(panel.data.kind, 'Hold');
    assert.equal(panel.data.yourRank, 'Citizen');
    assert.equal(panel.data.canManage, false);
    assert.deepEqual(panel.data.allegiances, [{ name: 'Whiterun', kind: 'Hold', rank: 'Citizen' }]);
    // The menu gets the mouse when it opens and gives it back when it closes.
    assert.deepEqual(focus, [{ actorId: ANA, focused: true }]);
    assert.equal(await service.handleUiEvent(ANA, { type: 'holdstone:close' }), true);
    assert.deepEqual(focus.at(-1), { actorId: ANA, focused: false });
    assert.equal(await service.handleUiEvent(ANA, { type: 'holdstone:other' }), false);
  });

  it('High Hrothgar: staff tie themselves to it; members show their allegiances everywhere', async () => {
    service.registerInteractions();
    await service.setMemberRank(STAFF_ACTOR, 'high_hrothgar', { id: 1, name: 'Staff Member' }, 'leader');
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 1, name: 'Staff Member' }, 'citizen');
    const ctx = { actorId: STAFF, characterId: 1, target: { formId: HROTHGAR_STONE }, data: {} };
    await interactionRegistry.get('holdstone.view').execute(ctx);
    const panel = modals.at(-1).data;
    assert.equal(panel.kind, 'Faction');
    assert.equal(panel.seat, null);
    assert.equal(panel.yourRank, 'Leader');
    assert.deepEqual(panel.allegiances.map((a) => a.name), ['High Hrothgar', 'Whiterun']);
  });
});

describe('holdstone-service: Riverwood answers to Whiterun', () => {
  const parcelLocks = require('./core/parcel-locks');
  const JARL = { characterId: 40, isStaff: false };
  const JARL_ACTOR = 0xff000040;
  const RIVERWOOD_STONE = 0xb4;

  beforeEach(async () => {
    await boot();
    service.registerInteractions();
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 40, name: 'Di Jarl' }, 'jarl');
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 20, name: 'Bo Guard' }, 'guard');
  });
  afterEach(() => { delete global.mp; });

  it('the Jarl of Whiterun leads Riverwood: names its Reeve, creates and locks its parcels', async () => {
    const r = await service.setMemberRank(JARL, 'riverwood', { id: 10, name: 'Ana Stone' }, 'reeve');
    assert.equal(r.ok, true, r.message);
    const p = await service.createParcel('riverwood', 'Sleeping Giant Inn');
    assert.equal(p.ok, true);
    const idx = service.getIndex();
    assert.equal(parcelLocks.canManageOrg(idx, 'riverwood', JARL), true);
    assert.equal(parcelLocks.canLockParcel(idx, idx.parcels.get(p.parcelId), JARL), true);
  });

  it('the Reeve of Riverwood does not lead Whiterun; a Whiterun Guard does not lead Riverwood', async () => {
    await service.setMemberRank(STAFF_ACTOR, 'riverwood', { id: 10, name: 'Ana Stone' }, 'reeve');
    const idx = service.getIndex();
    assert.equal(parcelLocks.canManageOrg(idx, 'whiterun', { characterId: 10 }), false);
    assert.equal(parcelLocks.canManageOrg(idx, 'riverwood', { characterId: 20 }), false);
    const r = await service.setMemberRank({ characterId: 20 }, 'riverwood', { id: 30, name: 'Cy' }, 'resident');
    assert.equal(r.ok, false);
  });

  it('the Riverwood panel says it answers to Whiterun; the Whiterun panel lists Riverwood', async () => {
    BASE_DESC_OF[RIVERWOOD_STONE] = `80a:${PLUGIN}`;
    try {
      await interactionRegistry.get('holdstone.view').execute({ actorId: JARL_ACTOR, characterId: 40, target: { formId: RIVERWOOD_STONE }, data: {} });
      const rw = modals.at(-1).data;
      assert.equal(rw.orgName, 'Riverwood');
      assert.deepEqual(rw.answersTo, ['Whiterun']);
      assert.equal(rw.canManage, true, 'the Jarl sees leadership actions at the Riverwood stone');
      await interactionRegistry.get('holdstone.view').execute({ actorId: JARL_ACTOR, characterId: 40, target: { formId: WHITERUN_STONE }, data: {} });
      assert.deepEqual(modals.at(-1).data.vassals, ['Riverwood']);
    } finally {
      delete BASE_DESC_OF[RIVERWOOD_STONE];
    }
  });

  it('opening locked Riverwood doors is not inherited: it needs a Riverwood rank, the owner or staff', async () => {
    const p = await service.createParcel('riverwood', 'Mill', 'resident');
    await service.addObject(p.parcelId, desc(CHEST), 'container');
    assert.equal(service.handleActivation(CHEST, JARL_ACTOR), false, 'the Jarl unlocks it rather than walking in');
    await service.setMemberRank(JARL, 'riverwood', { id: 20, name: 'Bo Guard' }, 'resident');
    assert.equal(service.handleActivation(CHEST, BO), undefined);
  });

  it('a parent that is not an organization is ignored with a log line', async () => {
    service.configure({ stoneList: () => ({ plugin: PLUGIN, stones: [{ id: 'orphan', name: 'Orphan', kind: 'town', hold: null, formId: '80d', parent: 'atlantis' }] }) });
    await service.syncOrganizations();
    assert.equal(db.tables.stone_orgs.find((o) => o.id === 'orphan').parent_id, null);
    assert.ok(errors.some((e) => /parent "atlantis"/.test(e)));
  });
});

describe('holdstone-service: parcel assignment', () => {
  beforeEach(boot);
  afterEach(() => { delete global.mp; });

  it('creates a parcel and adds a door; the teleport partner joins as an exit', async () => {
    const created = await service.createParcel('whiterun', 'Barracks', 'guard');
    assert.equal(created.ok, true);
    assert.equal(db.tables.parcels[0].hold_id, 'whiterun', 'located in the organization seat');
    assert.equal(service.findTeleportPartner(FRONT_DOOR), desc(INSIDE_DOOR));

    const added = await service.addObject(created.parcelId, desc(FRONT_DOOR), 'door', { partnerDesc: desc(INSIDE_DOOR) });
    assert.equal(added.ok, true, added.message);
    assert.match(added.message, /other side/);
    assert.deepEqual(db.tables.parcel_objects.map((r) => [r.object_id, r.locks]), [[desc(FRONT_DOOR), 1], [desc(INSIDE_DOOR), 0]]);
    assert.equal(service.getIndex().objectsById.get(FRONT_DOOR).parcelId, created.parcelId);
  });

  it('a council parcel has no hold; the Legion and the city can both name one "Barracks"', async () => {
    const hall = await service.createParcel('high_hrothgar', 'Council Hall');
    assert.equal(hall.ok, true);
    assert.equal(db.tables.parcels.at(-1).hold_id, null);
    assert.equal((await service.createParcel('whiterun', 'Barracks')).ok, true);
    assert.equal((await service.createParcel('imperial_legion', 'Barracks')).ok, true);
  });

  it('refuses an object that already belongs to another parcel', async () => {
    const a = await service.createParcel('whiterun', 'House A');
    const b = await service.createParcel('imperial_legion', 'House B');
    assert.equal((await service.addObject(a.parcelId, desc(CHEST), 'container')).ok, true);
    const clash = await service.addObject(b.parcelId, desc(CHEST), 'container');
    assert.equal(clash.ok, false);
    assert.match(clash.message, /already belongs to parcel #/);
  });

  it('rejects bad input: unknown kind, malformed FormDesc, duplicate names, unknown stone', async () => {
    const p = await service.createParcel('whiterun', 'Mill');
    assert.equal((await service.addObject(p.parcelId, desc(ROCK), 'statue')).ok, false);
    assert.equal((await service.addObject(p.parcelId, '12345', 'door')).ok, false);
    assert.equal((await service.createParcel('whiterun', 'mill')).ok, false);
    assert.match((await service.createParcel('nowhere', 'Mill')).message, /Unknown stone/);
    assert.equal(service.normalizeDesc('0x000A1:Skyrim.esm'), 'a1:Skyrim.esm');
  });

  it('removing an object unlocks it; deleting a parcel unlocks all of it', async () => {
    const p = await service.createParcel('whiterun', 'Shed');
    await service.addObject(p.parcelId, desc(CHEST), 'container');
    assert.equal(service.handleActivation(CHEST, ANA), false);
    assert.equal((await service.removeObject(desc(CHEST))).ok, true);
    assert.equal(service.handleActivation(CHEST, ANA), undefined);

    await service.addObject(p.parcelId, desc(CHEST), 'container');
    await service.deleteParcel(p.parcelId);
    assert.equal(service.handleActivation(CHEST, ANA), undefined);
  });

  it('detects doors and containers from the base record', () => {
    assert.equal(service.detectKind(FRONT_DOOR), 'door');
    assert.equal(service.detectKind(CHEST), 'container');
    assert.equal(service.detectKind(ROCK), null);
  });
});

describe('holdstone-service: activation blocking', () => {
  beforeEach(async () => {
    await boot();
    const p = await service.createParcel('whiterun', 'Barracks', 'guard');
    await service.addObject(p.parcelId, desc(FRONT_DOOR), 'door', { partnerDesc: desc(INSIDE_DOOR) });
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 10, name: 'Ana Stone' }, 'citizen');
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 20, name: 'Bo Guard' }, 'guard');
  });
  afterEach(() => { delete global.mp; });

  it('blocks a citizen with "It\'s locked." through mp.onActivate', () => {
    activationEvents.subscribe('holdstones', service.handleActivation);
    assert.equal(global.mp.onActivate(FRONT_DOOR, ANA), false);
    assert.equal(lastNote(ANA), "It's locked.");
  });

  it('lets the guard, staff and the owner through', async () => {
    assert.equal(service.handleActivation(FRONT_DOOR, BO), undefined);
    assert.equal(service.handleActivation(FRONT_DOOR, STAFF), undefined);
    await service.transferParcel(1, { id: 10, name: 'Ana Stone' });
    assert.equal(service.handleActivation(FRONT_DOOR, ANA), undefined);
  });

  it('a rank in another organization does not open it', async () => {
    await service.setMemberRank(STAFF_ACTOR, 'imperial_legion', { id: 10, name: 'Ana Stone' }, 'leader');
    assert.equal(service.handleActivation(FRONT_DOOR, ANA), false);
  });

  it('never blocks the exit side, unknown objects or NPC casters', () => {
    assert.equal(service.handleActivation(INSIDE_DOOR, ANA), undefined);
    assert.equal(service.handleActivation(ROCK, ANA), undefined);
    assert.equal(service.handleActivation(FRONT_DOOR, 0xff0000aa), undefined, 'NPC / no character');
  });

  it('unlocking the parcel opens it for everyone; locking closes it again', async () => {
    await service.setParcelLocked(1, false);
    assert.equal(service.handleActivation(FRONT_DOOR, ANA), undefined);
    await service.setParcelLocked(1, true);
    assert.equal(service.handleActivation(FRONT_DOOR, ANA), false);
  });

  it('lowering the minimum rank lets the citizen in; "none" makes it owner-only', async () => {
    await service.setParcelMinRank(1, 'citizen');
    assert.equal(service.handleActivation(FRONT_DOOR, ANA), undefined);
    await service.setParcelMinRank(1, 'none');
    assert.equal(service.handleActivation(FRONT_DOOR, BO), false);
  });

  it('a door flipped to "lock this side" blocks from inside too', async () => {
    await service.setObjectLocks(desc(INSIDE_DOOR), true);
    assert.equal(service.handleActivation(INSIDE_DOOR, ANA), false);
  });
});

describe('holdstone-service: ranks', () => {
  beforeEach(async () => {
    await boot();
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 30, name: 'Cy Steward' }, 'steward');
    await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 40, name: 'Di Jarl' }, 'jarl');
  });
  afterEach(() => { delete global.mp; });

  it('a steward sets a guard, and the player is told', async () => {
    const r = await service.setMemberRank({ characterId: 30, isStaff: false }, 'whiterun', { id: 20, name: 'Bo Guard' }, 'guard');
    assert.equal(r.ok, true, r.message);
    assert.match(lastNote(BO), /now Guard of Whiterun/);
  });

  it('a steward cannot crown a jarl or demote one, nor rank anyone in another organization', async () => {
    const steward = { characterId: 30, isStaff: false };
    assert.equal((await service.setMemberRank(steward, 'whiterun', { id: 20, name: 'Bo' }, 'jarl')).ok, false);
    assert.equal((await service.setMemberRank(steward, 'whiterun', { id: 40, name: 'Di' }, 'none')).ok, false);
    assert.equal((await service.setMemberRank(steward, 'imperial_legion', { id: 20, name: 'Bo' }, 'recruit')).ok, false);
  });

  it('unknown rank keys are refused with the list of ranks', async () => {
    const r = await service.setMemberRank(STAFF_ACTOR, 'whiterun', { id: 20, name: 'Bo' }, 'emperor');
    assert.equal(r.ok, false);
    assert.match(r.message, /citizen, guard, .*steward, jarl/);
  });

  it('staff edit a ladder: add a rank, remove one', async () => {
    assert.equal((await service.addRank('high_hrothgar', 'greybeard', 50, true, 'Greybeard')).ok, true);
    assert.equal(service.getIndex().ranksByOrg.get('high_hrothgar').at(-1).key, 'greybeard');
    assert.equal((await service.removeRank('high_hrothgar', 'greybeard')).ok, true);
    assert.equal((await service.addRank('high_hrothgar', 'x', 10, false, 'Clash')).ok, false, 'position taken');
  });

  it('character numbers resolve from the database', async () => {
    assert.deepEqual(await service.characterByNumber(2), { id: 20, name: 'Bo Guard', number: 2 });
    assert.equal(await service.characterByNumber(99), null);
  });
});

describe('holdstone-service: parceling tool and commands', () => {
  beforeEach(boot);
  afterEach(() => { delete global.mp; });

  it('with the tool on, E on a door opens the parcel menu instead of the door', async () => {
    const p = await service.createParcel('whiterun', 'Hall');
    service.startParcelTool(STAFF, p.parcelId);
    assert.equal(service.handleActivation(FRONT_DOOR, STAFF), false);
    assert.deepEqual(menus, [{ actorId: STAFF, targetId: FRONT_DOOR }]);
    service.stopTool(STAFF);
    assert.equal(service.handleActivation(FRONT_DOOR, STAFF), undefined);
  });

  it('staff commands refuse non-staff; /holdstone list shows every organization', async () => {
    await service.handleParcelCommand(ANA, 'create whiterun Sneaky');
    assert.match(lastNote(ANA), /Staff only/);
    assert.equal(db.tables.parcels.length, 0);
    await service.handleHoldstoneCommand(STAFF, 'list');
    assert.match(lastNote(STAFF), /high_hrothgar \(Faction\)/);
    assert.match(lastNote(STAFF), /riverwood \(Town\)/);
    assert.match(lastNote(STAFF), /riften \(Hold, no stone\)/);
  });

  it('/holdrank works with any stone key', async () => {
    await service.handleHoldRankCommand(STAFF, `imperial_legion 0x${BO.toString(16)} officer`);
    assert.match(lastNote(STAFF), /Bo Guard is now Officer of Imperial Legion/);
    await flush();
  });

  it('interactions: the add/remove actions follow the tool and never treat a stone as a door', async () => {
    service.registerInteractions();
    const p = await service.createParcel('whiterun', 'Hall');
    const add = interactionRegistry.get('parcel.add_object');
    const remove = interactionRegistry.get('parcel.remove_object');
    const ctx = { actorId: STAFF, characterId: 1, target: { formId: CHEST }, data: {} };

    assert.equal(await add.canSee(ctx), false, 'tool off');
    service.startParcelTool(STAFF, p.parcelId);
    assert.equal(await add.canSee(ctx), true);
    assert.equal(await add.canSee({ ...ctx, target: { formId: WHITERUN_STONE } }), false);
    assert.equal(await remove.canSee(ctx), false);

    const res = await add.execute(ctx);
    assert.match(res.message, /Container added/);
    assert.equal(await add.canSee(ctx), false, 'already in this parcel');
    assert.equal(await remove.canSee(ctx), true);

    const notDoor = await add.execute({ ...ctx, target: { formId: ROCK } });
    assert.match(notDoor.message, /Only doors and containers/);
  });
});
