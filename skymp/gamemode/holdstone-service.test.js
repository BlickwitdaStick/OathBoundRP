'use strict';

/**
 * holdstone-service: activation blocking, parcel assignment, ranks and the
 * parceling tool, against an in-memory fake of the v33 tables and a fake `mp`.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const service = require('./holdstone-service');
const activationEvents = require('./core/activation-events');
const interactionRegistry = require('./core/interaction-registry');
const physicalAnchorRegistry = require('./core/physical-anchor-registry');
const espm = require('./core/espm');

// ── fake world ──────────────────────────────────────────────────────────────
const FRONT_DOOR = 0xa1;
const INSIDE_DOOR = 0xa2;
const CHEST = 0xc1;
const STONE = 0xb0;
const ROCK = 0xe1;
const DOOR_BASE = 0x1000;
const CHEST_BASE = 0x2000;
const ROCK_BASE = 0x3000;
const BASE_OF = { [FRONT_DOOR]: DOOR_BASE, [INSIDE_DOOR]: DOOR_BASE, [CHEST]: CHEST_BASE, [ROCK]: ROCK_BASE, [STONE]: ROCK_BASE };

function installMp() {
  global.mp = {
    getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
    getIdFromDesc: (desc) => parseInt(desc.split(':')[0], 16),
    get: (id, prop) => (prop === 'baseDesc' && BASE_OF[id] ? `${BASE_OF[id].toString(16)}:Skyrim.esm` : undefined),
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
    holds: [{ id: 'whiterun', name: 'Whiterun' }, { id: 'riften', name: 'Riften' }],
    holdstones: [],
    hold_ranks: [
      { id: 1, hold_id: 'whiterun', rank_key: 'citizen', name: 'Citizen', position: 10, is_leader: 0 },
      { id: 2, hold_id: 'whiterun', rank_key: 'guard', name: 'Guard', position: 20, is_leader: 0 },
      { id: 3, hold_id: 'whiterun', rank_key: 'steward', name: 'Steward', position: 30, is_leader: 1 },
      { id: 4, hold_id: 'whiterun', rank_key: 'jarl', name: 'Jarl', position: 40, is_leader: 1 }
    ],
    hold_members: [],
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
  const log = [];
  const sql = (s) => s.replace(/\s+/g, ' ').trim();

  async function query(raw, p = []) {
    const s = sql(raw);
    log.push(s);
    if (s.startsWith('SELECT id, name FROM holds')) return t.holds;
    if (s.startsWith('SELECT hold_id, object_id FROM holdstones')) return t.holdstones;
    if (s.startsWith('SELECT id, hold_id, rank_key')) return t.hold_ranks;
    if (s.startsWith('SELECT hold_id, character_id, rank_id')) return t.hold_members;
    if (s.startsWith('SELECT id, hold_id, name, owner_character_id')) return t.parcels;
    if (s.startsWith('SELECT object_id, parcel_id')) return t.parcel_objects;
    if (s.includes('FROM characters WHERE char_number')) return t.characters.filter((c) => c.char_number === p[0]);
    if (s.includes('FROM characters WHERE id IN')) return t.characters.filter((c) => p.includes(c.id));

    if (s.startsWith('DELETE FROM holdstones WHERE hold_id')) {
      t.holdstones = t.holdstones.filter((r) => r.hold_id !== p[0]);
      return { affectedRows: 1 };
    }
    if (s.startsWith('DELETE FROM holdstones WHERE object_id')) {
      t.holdstones = t.holdstones.filter((r) => !(r.object_id === p[0] && r.hold_id !== p[1]));
      return { affectedRows: 1 };
    }
    if (s.startsWith('INSERT INTO holdstones')) {
      t.holdstones = t.holdstones.filter((r) => r.hold_id !== p[0]).concat({ hold_id: p[0], object_id: p[1] });
      return { affectedRows: 1 };
    }
    if (s.startsWith('DELETE FROM hold_members')) {
      t.hold_members = t.hold_members.filter((r) => !(r.hold_id === p[0] && r.character_id === p[1]));
      return {};
    }
    if (s.startsWith('INSERT INTO hold_members')) {
      t.hold_members = t.hold_members.filter((r) => !(r.hold_id === p[0] && r.character_id === p[1]))
        .concat({ hold_id: p[0], character_id: p[1], rank_id: p[2] });
      return {};
    }
    if (s.startsWith('INSERT INTO parcels')) {
      const id = nextParcel++;
      t.parcels.push({ id, hold_id: p[0], name: p[1], owner_character_id: null, min_rank_id: p[2], locked: 1 });
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
  return { query, tables: t, log };
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
const CY = 0xff000030;

let db;
let notes;
let menus;
let modals;

function setup() {
  installMp();
  espm._limparCache();
  service._resetForTest();
  activationEvents._resetForTest();
  interactionRegistry._reset();
  physicalAnchorRegistry._reset();
  db = createDb();
  notes = [];
  menus = [];
  modals = [];
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
    openInteractionMenu: (actorId, targetId) => menus.push({ actorId, targetId }),
    logger: { log() {}, error() {} }
  });
}

const desc = (id) => `${id.toString(16)}:Skyrim.esm`;
const lastNote = (actorId) => [...notes].reverse().find((n) => n.actorId === actorId)?.message;

describe('holdstone-service: parcel assignment', () => {
  beforeEach(setup);
  afterEach(() => { delete global.mp; });

  it('creates a parcel and adds a door; the teleport partner joins as an exit', async () => {
    await service.reload();
    const created = await service.createParcel('whiterun', 'Barracks', 'guard');
    assert.equal(created.ok, true);
    assert.equal(service.findTeleportPartner(FRONT_DOOR), desc(INSIDE_DOOR));

    const added = await service.addObject(created.parcelId, desc(FRONT_DOOR), 'door', { partnerDesc: desc(INSIDE_DOOR) });
    assert.equal(added.ok, true, added.message);
    assert.match(added.message, /other side/);
    const rows = db.tables.parcel_objects;
    assert.deepEqual(rows.map((r) => [r.object_id, r.locks]), [[desc(FRONT_DOOR), 1], [desc(INSIDE_DOOR), 0]]);
    assert.equal(service.getIndex().objectsById.get(FRONT_DOOR).parcelId, created.parcelId);
  });

  it('refuses an object that already belongs to another parcel, and holdstones', async () => {
    await service.reload();
    const a = await service.createParcel('whiterun', 'House A');
    const b = await service.createParcel('whiterun', 'House B');
    assert.equal((await service.addObject(a.parcelId, desc(CHEST), 'container')).ok, true);
    const clash = await service.addObject(b.parcelId, desc(CHEST), 'container');
    assert.equal(clash.ok, false);
    assert.match(clash.message, /already belongs to parcel #/);

    await service.setHoldstone('whiterun', desc(STONE));
    assert.equal((await service.addObject(a.parcelId, desc(STONE), 'container')).ok, false);
  });

  it('rejects bad input: unknown kind, malformed FormDesc, duplicate names', async () => {
    await service.reload();
    const p = await service.createParcel('whiterun', 'Mill');
    assert.equal((await service.addObject(p.parcelId, desc(ROCK), 'statue')).ok, false);
    assert.equal((await service.addObject(p.parcelId, '12345', 'door')).ok, false);
    assert.equal((await service.createParcel('whiterun', 'mill')).ok, false);
    assert.equal((await service.createParcel('nowhere', 'Mill')).ok, false);
    assert.equal(service.normalizeDesc('0x000A1:Skyrim.esm'), 'a1:Skyrim.esm');
  });

  it('removing an object unlocks it; deleting a parcel unlocks all of it', async () => {
    await service.reload();
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
    installMp();
    espm._limparCache();
    assert.equal(service.detectKind(FRONT_DOOR), 'door');
    assert.equal(service.detectKind(CHEST), 'container');
    assert.equal(service.detectKind(ROCK), null);
  });
});

describe('holdstone-service: activation blocking', () => {
  beforeEach(async () => {
    setup();
    await service.reload();
    const p = await service.createParcel('whiterun', 'Barracks', 'guard');
    await service.addObject(p.parcelId, desc(FRONT_DOOR), 'door', { partnerDesc: desc(INSIDE_DOOR) });
    await service.setMemberRank({ isStaff: true, characterId: 1 }, 'whiterun', { id: 10, name: 'Ana Stone' }, 'citizen');
    await service.setMemberRank({ isStaff: true, characterId: 1 }, 'whiterun', { id: 20, name: 'Bo Guard' }, 'guard');
  });
  afterEach(() => { delete global.mp; });

  it('blocks a citizen with "It\'s locked." through mp.onActivate', async () => {
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
    setup();
    await service.reload();
    const staff = { isStaff: true, characterId: 1 };
    await service.setMemberRank(staff, 'whiterun', { id: 30, name: 'Cy Steward' }, 'steward');
    await service.setMemberRank(staff, 'whiterun', { id: 40, name: 'Di Jarl' }, 'jarl');
  });
  afterEach(() => { delete global.mp; });

  it('a steward sets a guard, and the player is told', async () => {
    const r = await service.setMemberRank({ characterId: 30, isStaff: false }, 'whiterun', { id: 20, name: 'Bo Guard' }, 'guard');
    assert.equal(r.ok, true, r.message);
    assert.match(lastNote(BO), /now Guard of Whiterun/);
  });

  it('a steward cannot crown a jarl or demote one', async () => {
    const steward = { characterId: 30, isStaff: false };
    assert.equal((await service.setMemberRank(steward, 'whiterun', { id: 20, name: 'Bo' }, 'jarl')).ok, false);
    assert.equal((await service.setMemberRank(steward, 'whiterun', { id: 40, name: 'Di' }, 'none')).ok, false);
  });

  it('unknown rank keys are refused with the list of ranks', async () => {
    const r = await service.setMemberRank({ isStaff: true }, 'whiterun', { id: 20, name: 'Bo' }, 'emperor');
    assert.equal(r.ok, false);
    assert.match(r.message, /citizen, guard, steward, jarl/);
  });

  it('character numbers resolve from the database', async () => {
    assert.deepEqual(await service.characterByNumber(2), { id: 20, name: 'Bo Guard', number: 2 });
    assert.equal(await service.characterByNumber(99), null);
  });
});

describe('holdstone-service: parceling tool and holdstone', () => {
  beforeEach(async () => {
    setup();
    await service.reload();
  });
  afterEach(() => { delete global.mp; });

  it('with the tool on, E on a door opens the parcel menu instead of the door', async () => {
    const p = await service.createParcel('whiterun', 'Hall');
    service.startParcelTool(STAFF, p.parcelId);
    assert.equal(service.handleActivation(FRONT_DOOR, STAFF), false);
    assert.deepEqual(menus, [{ actorId: STAFF, targetId: FRONT_DOOR }]);
    service.stopTool(STAFF);
    assert.equal(service.handleActivation(FRONT_DOOR, STAFF), undefined);
  });

  it('/holdstone place: the next activated object becomes the stone', async () => {
    await service.handleHoldstoneCommand(STAFF, 'place whiterun');
    assert.equal(service.handleActivation(STONE, STAFF), false);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(db.tables.holdstones, [{ hold_id: 'whiterun', object_id: desc(STONE) }]);
    assert.equal(service.getIndex().holdstoneById.get(STONE), 'whiterun');
  });

  it('staff commands refuse non-staff', async () => {
    await service.handleParcelCommand(ANA, 'create whiterun Sneaky');
    assert.match(lastNote(ANA), /Staff only/);
    assert.equal(db.tables.parcels.length, 0);
  });

  it('interactions: the add/remove actions follow the tool and execute against the target', async () => {
    service.registerInteractions();
    const p = await service.createParcel('whiterun', 'Hall');
    const add = interactionRegistry.get('parcel.add_object');
    const remove = interactionRegistry.get('parcel.remove_object');
    const ctx = { actorId: STAFF, characterId: 1, target: { formId: CHEST }, data: {} };

    assert.equal(await add.canSee(ctx), false, 'tool off');
    service.startParcelTool(STAFF, p.parcelId);
    assert.equal(await add.canSee(ctx), true);
    assert.equal(await remove.canSee(ctx), false);

    const res = await add.execute(ctx);
    assert.match(res.message, /Container added/);
    assert.equal(await add.canSee(ctx), false, 'already in this parcel');
    assert.equal(await remove.canSee(ctx), true);

    const notDoor = await add.execute({ ...ctx, target: { formId: ROCK } });
    assert.match(notDoor.message, /Only doors and containers/);
  });

  it('interactions: a citizen at the stone sees "Hold" but not leadership actions', async () => {
    service.registerInteractions();
    await service.setHoldstone('whiterun', desc(STONE));
    await service.setMemberRank({ isStaff: true }, 'whiterun', { id: 10, name: 'Ana' }, 'citizen');
    const ctx = { actorId: ANA, characterId: 10, target: { formId: STONE }, data: {} };
    assert.equal(await interactionRegistry.get('holdstone.view').canSee(ctx), true);
    assert.equal(await interactionRegistry.get('holdstone.create_parcel').canSee(ctx), false);
    await interactionRegistry.get('holdstone.view').execute(ctx);
    assert.equal(modals.at(-1).type, 'holdstone:open');
    assert.equal(modals.at(-1).data.yourRank, 'Citizen');
    assert.equal(modals.at(-1).data.canManage, false);
  });
});

describe('holdstone-service: holdstone model (OathboundHoldstone.esp)', () => {
  const HOLDSTONE_BASE = 0xfe000800;
  let placed;
  let sets;
  let placedBy;
  let destroyed;
  let nextRef;

  beforeEach(async () => {
    setup();
    placed = new Map(); // refId → baseId
    placedBy = new Map(); // refId → Papyrus self it was placed at
    sets = [];
    destroyed = [];
    nextRef = 0xff000100;
    const base = global.mp;
    global.mp = {
      ...base,
      // runtime references have no plugin in their desc, as in SkyMP's FormDesc
      getDescFromId: (id) => (id >= 0xff000000 ? (id - 0xff000000).toString(16) : base.getDescFromId(id)),
      getIdFromDesc: (d) => {
        if (d === service.HOLDSTONE_BASE_DESC) return HOLDSTONE_BASE;
        return d.includes(':') ? base.getIdFromDesc(d) : 0xff000000 + parseInt(d, 16);
      },
      get: (id, prop) => {
        if (prop === 'baseDesc' && placed.has(id)) return service.HOLDSTONE_BASE_DESC;
        if (prop === 'locationalData' && id === STAFF) return { pos: [1000, 2000, 50], rot: [0, 0, 90], cellOrWorldDesc: '3c:Skyrim.esm' };
        return base.get(id, prop);
      },
      // SkyMP's server-side Papyrus PlaceAtMe: a new reference at the caller's
      // position, returned as {type:'form', desc}.
      callPapyrusFunction: (kind, cls, fn, self, args) => {
        if (fn !== 'PlaceAtMe') throw new Error(`unexpected Papyrus ${fn}`);
        assert.equal(args[0].type, 'espm', 'the base goes as baseRef');
        const id = nextRef++;
        placed.set(id, global.mp.getIdFromDesc(args[0].desc));
        placedBy.set(id, self);
        return { type: 'form', desc: global.mp.getDescFromId(id) };
      },
      place: () => { throw new Error('mp.place leaves the reference at 0,0,0; use PlaceAtMe'); },
      // Real SkyMP refuses this for non-actors ("can only change 'locationalData' for actors").
      set: (id, prop, value) => {
        if (prop === 'locationalData' && placed.has(id)) throw new Error("mp.set can only change 'locationalData' for actors, not for refrs");
        sets.push({ id, prop, value });
      },
      destroyActor: (id) => { destroyed.push(id); placed.delete(id); }
    };
    service.registerPhysicalAnchors();
    await service.reload();
  });
  afterEach(() => { delete global.mp; });

  /** A holdstone already in the world that no hold owns. */
  const newStone = () => { const id = nextRef++; placed.set(id, HOLDSTONE_BASE); return id; };

  it('/holdstone spawn puts the stone where staff stands (Papyrus PlaceAtMe) and binds it', async () => {
    await service.handleHoldstoneCommand(STAFF, 'spawn whiterun');
    assert.match(lastNote(STAFF), /Whiterun holdstone placed where you stand/);
    const [ref] = placed.keys();
    assert.equal(placed.get(ref), HOLDSTONE_BASE);
    assert.deepEqual(placedBy.get(ref), { type: 'form', desc: global.mp.getDescFromId(STAFF) }, 'placed at the staff member');
    assert.deepEqual(sets, [], 'no attempt to move a reference with mp.set');
    assert.deepEqual(db.tables.holdstones, [{ hold_id: 'whiterun', object_id: '100' }]);
    assert.equal(service.getIndex().holdstoneById.get(ref), 'whiterun');
    assert.equal(physicalAnchorRegistry.has(ref), true, 'pressing E on it opens the hold menu');
  });

  it('spawning again moves the hold to the new stone and removes the old one', async () => {
    await service.spawnHoldstone(STAFF, 'whiterun');
    const res = await service.spawnHoldstone(STAFF, 'whiterun');
    assert.equal(res.ok, true);
    assert.match(res.message, /old one was removed/);
    assert.deepEqual(destroyed, [0xff000100]);
    assert.deepEqual(db.tables.holdstones, [{ hold_id: 'whiterun', object_id: '101' }]);
  });

  it('clearing a hold removes a spawned stone, but never a map object', async () => {
    await service.setHoldstone('riften', desc(STONE));
    await service.clearHoldstone('riften');
    assert.deepEqual(destroyed, [], 'a stone that is part of the map stays');

    await service.spawnHoldstone(STAFF, 'whiterun');
    const res = await service.clearHoldstone('whiterun');
    assert.match(res.message, /removed from the world/);
    assert.deepEqual(destroyed, [0xff000100]);
  });

  it('an unbound holdstone tells the player it belongs to no hold, and staff how to bind it', async () => {
    const ref = newStone();
    assert.equal(service.handleActivation(ref, ANA), false);
    assert.match(lastNote(ANA), /belongs to no hold yet/);
    assert.equal(service.handleActivation(ref, STAFF), false);
    assert.match(lastNote(STAFF), /\/holdstone place <hold>/);
  });

  it('/holdstone place works on a spawned stone; a typed desc without its plugin is still refused', async () => {
    const ref = newStone();
    await service.handleHoldstoneCommand(STAFF, 'place riften');
    service.handleActivation(ref, STAFF);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(service.getIndex().holdstoneById.get(ref), 'riften');

    const typed = await service.setHoldstone('whiterun', '12eb7');
    assert.equal(typed.ok, false);
  });

  it('refuses when the plugin is not loaded or the hold is unknown', async () => {
    assert.match((await service.spawnHoldstone(STAFF, 'nowhere')).message, /Unknown hold/);
    global.mp.getIdFromDesc = () => { throw new Error('OathboundHoldstone.esp not found in loaded files'); };
    assert.match((await service.spawnHoldstone(STAFF, 'whiterun')).message, /not loaded on the server/);
    assert.equal(placed.size, 0);
  });

  it('non-staff cannot spawn', async () => {
    await service.handleHoldstoneCommand(ANA, 'spawn whiterun');
    assert.match(lastNote(ANA), /Staff only/);
    assert.equal(placed.size, 0);
  });
});
