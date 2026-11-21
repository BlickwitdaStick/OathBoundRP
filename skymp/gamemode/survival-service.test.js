'use strict';

/**
 * survival-service against a fake `mp`, database and game clock: login/logout
 * persistence, time passing, eating, resting in beds, warmth from clothing,
 * and the /needs and /setneed commands.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const service = require('./survival-service');
const activationEvents = require('./core/activation-events');

const ACTOR = 0xff000010;
const STAFF = 0xff000001;
const CHAR = 10;
const TAMRIEL = 0x3c;
const INN = 0x16bdf;          // an interior cell
const COLD_CELL = 0x1527e;    // in data coldInteriorCells
const BED = 0xb100;           // reference
const BEDROLL = 0xb200;
const BED_BASE = 0x5001;
const BEDROLL_BASE = 0x5002;
const HOT_STEW = 0xfe0019e9;  // Survival_FoodHotHorkerStew once resolved from its FormDesc
const WARM_COAT = 0x7001;
const IRON_HELM = 0x7002;
const TORCH = 0x1d4ec;
const KW_WARM = 0x1002ed9;
const KW_BODYHEAD = 0x1002edb;

let rows;        // character_id → needs row
let notes;
let hours;       // game clock
let nowMs;
let loc;         // actor's locationalData
let worn;        // equipment entries

const kwda = (...ids) => {
  const b = Buffer.alloc(ids.length * 4);
  ids.forEach((id, i) => b.writeUInt32LE(id, i * 4));
  return [...b];
};

function fakeMp() {
  return {
    getIdFromDesc: (desc) => {
      if (desc === '9e8:ccQDRSSE001-SurvivalMode.esl') return HOT_STEW;
      if (desc.includes(':')) return parseInt(desc.split(':')[0], 16);
      return 0xff000000 + parseInt(desc, 16);
    },
    get: (id, prop) => {
      if (prop === 'locationalData' && id === ACTOR) return loc;
      if (prop === 'equipment' && id === ACTOR) return { inv: { entries: worn } };
      if (prop === 'baseDesc' && id === BED) return `${BED_BASE.toString(16)}:Skyrim.esm`;
      if (prop === 'baseDesc' && id === BEDROLL) return `${BEDROLL_BASE.toString(16)}:Skyrim.esm`;
      return undefined;
    },
    lookupEspmRecordById: (id) => {
      if (id === TAMRIEL) return { record: { type: 'WRLD', fields: [] } };
      if (id === INN || id === COLD_CELL) return { record: { type: 'CELL', fields: [] } };
      if (id === BED_BASE) return { record: { type: 'FURN', editorId: 'CommonBedDouble01', fields: [] } };
      if (id === BEDROLL_BASE) return { record: { type: 'FURN', editorId: 'BedrollGround01', fields: [] } };
      if (id === WARM_COAT) return { record: { type: 'ARMO', fields: [{ type: 'KWDA', data: kwda(KW_WARM, KW_BODYHEAD) }] }, toGlobalRecordId: (x) => x };
      if (id === IRON_HELM) return { record: { type: 'ARMO', fields: [{ type: 'KWDA', data: kwda(KW_BODYHEAD) }] }, toGlobalRecordId: (x) => x };
      if (id === TORCH) return { record: { type: 'LIGH', fields: [] } };
      return {};
    }
  };
}

function fakeDb() {
  return {
    async query(sql, p) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT hunger, exhaustion, cold FROM character_needs')) return rows.has(p[0]) ? [rows.get(p[0])] : [];
      if (s.startsWith('INSERT INTO character_needs')) {
        rows.set(p[0], { hunger: p[1], exhaustion: p[2], cold: p[3] });
        return {};
      }
      throw new Error(`unexpected SQL: ${s}`);
    }
  };
}

const lastNote = () => notes.at(-1)?.message;
const needs = () => rows.get(CHAR);

beforeEach(() => {
  service._resetForTest();
  activationEvents._resetForTest();
  rows = new Map();
  notes = [];
  hours = 1000;
  nowMs = 0;
  loc = { pos: [0, 0, 0], cellOrWorldDesc: `${INN.toString(16)}:Skyrim.esm` };
  worn = [];
  global.mp = { getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm` };
  service.configure({
    db: fakeDb(),
    mp: fakeMp(),
    commands: { sendNotification: (actorId, message) => notes.push({ actorId, message }) },
    gameHours: () => hours,
    isStaff: (id) => id === STAFF,
    now: () => nowMs,
    logger: { log() {}, warn() {}, error() {} }
  });
});
afterEach(() => { service._resetForTest(); delete global.mp; });

async function login(start) {
  if (start) rows.set(CHAR, start);
  await service.onLogin(ACTOR, CHAR);
}

describe('survival-service: sessions', () => {
  it('a new character starts fine; needs grow only with game time', async () => {
    await login();
    hours += 0.5;
    await service.update(ACTOR);
    await service.onDisconnect(ACTOR);
    assert.deepEqual(needs(), { hunger: 3.75, exhaustion: 4.5, cold: 0 });
  });

  it('needs carry over between sessions; time offline does not count', async () => {
    await login({ hunger: 500, exhaustion: 100, cold: 0 });
    await service.onDisconnect(ACTOR);
    hours += 48; // two game days offline
    await login();
    await service.update(ACTOR);
    assert.equal(service.isOnline(ACTOR), true);
    await service.onDisconnect(ACTOR);
    assert.deepEqual(needs(), { hunger: 500, exhaustion: 100, cold: 0 });
  });

  it('one tick never moves more than one game hour', async () => {
    await login();
    hours += 30;
    await service.update(ACTOR);
    await service.onDisconnect(ACTOR);
    assert.equal(needs().hunger, 7.5);
  });

  it('tells the player when a need changes stage, and saves then', async () => {
    await login({ hunger: 75, exhaustion: 0, cold: 0 });
    hours += 1;
    await service.update(ACTOR);
    assert.equal(lastNote(), 'You feel satisfied.');
    assert.equal(needs().hunger, 82.5);
  });
});

describe('survival-service: cold', () => {
  it('cold interiors chill you; ordinary interiors warm you', async () => {
    loc = { pos: [0, 0, 0], cellOrWorldDesc: `${COLD_CELL.toString(16)}:Skyrim.esm` };
    await login();
    hours += 1;
    const s = await service.update(ACTOR);
    assert.equal(s.area, 'coldIndoors');
    assert.equal(s.needs.cold, 150);
    loc = { pos: [0, 0, 0], cellOrWorldDesc: `${INN.toString(16)}:Skyrim.esm` };
    hours += 1;
    const warm = await service.update(ACTOR);
    assert.equal(warm.area, 'indoors');
    assert.equal(warm.needs.cold, 0);
  });

  it('high up outdoors is freezing; a warm coat, a helmet and a torch slow it', async () => {
    loc = { pos: [0, 0, 20000], cellOrWorldDesc: '3c:Skyrim.esm' };
    await login();
    hours += 1;
    const bare = (await service.update(ACTOR)).needs.cold;
    assert.equal(bare, 580);

    await service.onDisconnect(ACTOR);
    rows.set(CHAR, { hunger: 0, exhaustion: 0, cold: 0 });
    worn = [{ baseId: WARM_COAT, count: 1, worn: true }, { baseId: IRON_HELM, count: 1, worn: true }, { baseId: TORCH, count: 1, wornLeft: true }];
    await login();
    hours += 1;
    const dressed = (await service.update(ACTOR)).needs.cold;
    // coat 0.2 + helmet 0.1 + torch 0.12 = 0.42 warmth
    assert.equal(Math.round(dressed), Math.round(580 * 0.58));
  });

  it('a hot meal removes cold and keeps you warmer for two game hours', async () => {
    loc = { pos: [0, 0, 20000], cellOrWorldDesc: '3c:Skyrim.esm' };
    await login({ hunger: 300, exhaustion: 0, cold: 600 });
    service.handleEat(ACTOR, HOT_STEW);
    assert.equal(notes.some((n) => n.message === 'The hot meal warms you.'), true);
    hours += 1;
    const s = await service.update(ACTOR);
    assert.equal(s.needs.hunger, 7.5, 'large meal: 300 - 380 → 0, then one game hour');
    assert.equal(Math.round(s.needs.cold), Math.round(400 + 580 * 0.88));
  });
});

describe('survival-service: eating and resting', () => {
  it('vanilla food restores hunger by its Survival Mode size; unknown items do nothing', async () => {
    await login({ hunger: 500, exhaustion: 0, cold: 0 });
    service.handleEat(ACTOR, 0x64b43); // FoodPie: medium, 220
    service.handleEat(ACTOR, 0x123456);
    const s = await service.update(ACTOR);
    assert.equal(s.needs.hunger, 280);
    assert.equal(lastNote(), 'You are getting peckish.');
  });

  it('pressing E on a bed rests you while you stay next to it', async () => {
    await login({ hunger: 0, exhaustion: 600, cold: 0 });
    assert.equal(service.handleActivation(BED, ACTOR), undefined, 'never blocks the bed');
    assert.match(lastNote(), /lie down to rest/);
    hours += 1;
    assert.equal((await service.update(ACTOR)).needs.exhaustion, 480);
    loc = { pos: [500, 0, 0], cellOrWorldDesc: loc.cellOrWorldDesc };
    hours += 1;
    const s = await service.update(ACTOR);
    assert.equal(notes.some((n) => n.message === 'You get up.'), true);
    assert.equal(s.needs.exhaustion, 489);
  });

  it('a bedroll rests you only down to 200', async () => {
    await login({ hunger: 0, exhaustion: 300, cold: 0 });
    service.handleActivation(BEDROLL, ACTOR);
    hours += 1;
    await service.update(ACTOR);
    hours += 1;
    const s = await service.update(ACTOR);
    assert.equal(s.needs.exhaustion, 200);
    assert.equal(notes.some((n) => /as well as a bedroll allows/.test(n.message)), true);
  });

  it('other furniture and offline players are ignored', async () => {
    assert.equal(service.handleActivation(BED, ACTOR), undefined);
    assert.equal(notes.length, 0);
  });
});

describe('survival-service: commands', () => {
  const cmd = (name) => service.commandDefs().find((c) => c.name === name).handler;

  it('/needs shows every need with its stage and where you are', async () => {
    await login({ hunger: 400, exhaustion: 50, cold: 0 });
    await cmd('/needs')(ACTOR, '');
    assert.match(lastNote(), /Hunger: Hungry \(400\/1000\) · Exhaustion: Well Rested \(50\/960\) · Cold: Warm \(0\/1000\) · You are in indoors/);
  });

  it('/setneed is staff only and validates input', async () => {
    await login();
    await cmd('/setneed')(ACTOR, `0x${ACTOR.toString(16)} hunger 900`);
    assert.equal(lastNote(), 'Staff only.');
    await cmd('/setneed')(STAFF, `0x${ACTOR.toString(16)} thirst 10`);
    assert.match(lastNote(), /hunger, exhaustion or cold/);
    await cmd('/setneed')(STAFF, `0x${ACTOR.toString(16)} hunger 900`);
    assert.match(lastNote(), /hunger set to 900: Starving/);
    assert.equal(needs().hunger, 900);
  });
});
