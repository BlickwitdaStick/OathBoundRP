const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { alreadyAt, createPositionPersistence, loadStartPoints, normalizeCell, toCellDesc, loginLocation, cellCheckerFor, MIN_MOVE, WRITE_MS } = require('./position-persistence');

const START = { pos: [35, -165, -189], cell: '162e2' };

describe('position persistence', () => {
  let queries, locs, chars, pp, clock;
  const A = 0xff000001;

  beforeEach(() => {
    queries = [];
    clock = 1000000;
    locs = new Map([[A, { pos: [100, 200, 300], rot: [0, 0, 90], cellOrWorldDesc: '3c:Skyrim.esm' }]]);
    chars = new Map([[A, { characterId: 7 }]]);
    pp = createPositionPersistence({
      db: { query: async (sql, params) => { queries.push(params); return { affectedRows: 1 }; } },
      mpApi: { get: (id) => locs.get(id) },
      listActive: () => [...chars.keys()],
      getCharacter: (id) => chars.get(id) || null,
      startPoints: [START],
      logger: { error() {}, warn() {} },
      now: () => clock
    });
  });

  it('does not save before the login placed the character (would store the default spawn)', async () => {
    await pp.tick();
    assert.equal(queries.length, 0);
  });

  it('saves position, angle and cell once restored', async () => {
    pp.markRestored(A);
    await pp.tick();
    assert.deepEqual(queries[0], [100, 200, 300, 90, '3c:Skyrim.esm', 7]);
  });

  it('skips small moves, saves real ones and cell changes', async () => {
    pp.markRestored(A);
    await pp.tick();
    locs.get(A).pos = [100 + MIN_MOVE / 2, 200, 300];
    await pp.tick();
    assert.equal(queries.length, 1, 'half a step is not worth a write');
    locs.get(A).pos = [100 + MIN_MOVE * 3, 200, 300];
    await pp.tick();
    assert.equal(queries.length, 1, 'a real move inside the cell waits for WRITE_MS');
    clock += WRITE_MS;
    await pp.tick();
    assert.equal(queries.length, 2);
    locs.get(A).cellOrWorldDesc = '1a2b:Skyrim.esm';
    await pp.tick();
    assert.equal(queries.length, 3, 'entering a building is always saved');
  });

  it('on logout writes the last position seen online, never the actor read afterwards', async () => {
    pp.markRestored(A);
    await pp.tick();                          // seen + saved at (100,200,300)
    locs.get(A).pos = [140, 200, 300];        // moved a little: seen, not written
    await pp.tick();
    assert.equal(queries.length, 1);
    // Disconnect noticed late: SkyMP already put the actor back at the start point.
    locs.set(A, { pos: START.pos.slice(), rot: [0, 0, 180], cellOrWorldDesc: '0x162e2' });
    await pp.onDisconnect(A);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1].slice(0, 3), [140, 200, 300], 'the last online position, not the start point');
  });

  it('never saves a position at the start point (Riverwood bug)', async () => {
    locs.set(A, { pos: START.pos.slice(), rot: [0, 0, 180], cellOrWorldDesc: '162e2:Skyrim.esm' });
    pp.markRestored(A);
    await pp.tick();
    await pp.onDisconnect(A);
    assert.equal(queries.length, 0);
  });

  it('logout without having moved since the last write does not write again', async () => {
    pp.markRestored(A);
    await pp.tick();
    await pp.onDisconnect(A);
    assert.equal(queries.length, 1);
  });

  it('forgets the actor after logout, and a new login starts clean', async () => {
    pp.markRestored(A);
    await pp.tick();
    await pp.onDisconnect(A);
    chars.delete(A);
    await pp.tick();
    assert.equal(queries.length, 1);
  });

  it('never saves an actor stuck in a plugin-less (nonexistent) cell', async () => {
    // What the old '0x162e2' login teleport produced: SkyMP reports the cell
    // back as "162e2" and rejects every client movement from then on.
    locs.set(A, { pos: [500, 600, 700], rot: [0, 0, 0], cellOrWorldDesc: '162e2' });
    pp.markRestored(A);
    await pp.tick();
    await pp.onDisconnect(A);
    assert.equal(queries.length, 0);
  });

  it('logout writes the latest position even when the periodic write was rate-limited', async () => {
    pp.markRestored(A);
    await pp.tick();
    locs.get(A).pos = [2000, 200, 300];
    await pp.tick();
    assert.equal(queries.length, 1);
    await pp.onDisconnect(A);
    assert.deepEqual(queries[1], [2000, 200, 300, 90, '3c:Skyrim.esm', 7]);
  });

  it('disconnect before any position was seen writes nothing and does not throw', async () => {
    pp.markRestored(A);
    assert.equal(await pp.onDisconnect(A), false);
  });

  it('ignores an unreadable position instead of saving garbage', async () => {
    pp.markRestored(A);
    locs.set(A, { pos: [NaN, 0, 0], cellOrWorldDesc: '3c:Skyrim.esm' });
    await pp.tick();
    locs.set(A, null);
    await pp.tick();
    await pp.onDisconnect(A);
    assert.equal(queries.length, 0);
  });
});

describe('position persistence: start points', () => {
  it('normalizes cell descriptors from settings and from SkyMP', () => {
    assert.equal(normalizeCell('0x162E2'), '162e2');
    assert.equal(normalizeCell('162e2:Skyrim.esm'), '162e2');
    assert.equal(normalizeCell('162e2'), '162e2');
  });

  it('reads startPoints from server-settings.json (object or array, with BOM)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
    const f = path.join(dir, 'server-settings.json');
    fs.writeFileSync(f, '﻿' + JSON.stringify({ startPoints: { pos: [35, -165, -189], worldOrCell: '0x162e2', angleZ: 180 } }));
    assert.deepEqual(loadStartPoints(f), [{ pos: [35, -165, -189], cell: '162e2' }]);
    assert.deepEqual(loadStartPoints(path.join(dir, 'missing.json')), []);
  });
});

describe('position persistence: cell descriptors for the login teleport', () => {
  it('turns stored cells into the id:plugin form SkyMP needs', () => {
    assert.equal(toCellDesc('0x162e2'), '162e2:Skyrim.esm', 'the old column default');
    assert.equal(toCellDesc('162e2'), '162e2:Skyrim.esm', 'what the broken state saved back');
    assert.equal(toCellDesc('162E2:Skyrim.esm'), '162e2:Skyrim.esm');
    assert.equal(toCellDesc('0x3c:Skyrim.esm'), '3c:Skyrim.esm');
    assert.equal(toCellDesc('114db:JKs Skyrim.esp'), '114db:JKs Skyrim.esp');
  });

  it('asks SkyMP for bare ids, which knows the load order', () => {
    const seen = [];
    assert.equal(toCellDesc('0x0201a26f', (id) => { seen.push(id); return '1a26f:Dawnguard.esm'; }), '1a26f:Dawnguard.esm');
    assert.deepEqual(seen, [0x0201a26f]);
    assert.equal(toCellDesc('0x162e2', () => { throw new Error('no'); }), '162e2:Skyrim.esm');
    assert.equal(toCellDesc('0x162e2', () => '162e2'), '162e2:Skyrim.esm', 'a plugin-less answer is not trusted');
  });

  it('refuses what it cannot resolve', () => {
    for (const bad of [null, undefined, '', 'abc:', 'Whiterun', '0x0', '0xff0162e2', '0x0201a26f']) {
      assert.equal(toCellDesc(bad), null, String(bad));
    }
  });

  it('builds the login locationalData from a characters row', () => {
    const row = { pos_x: 35, pos_y: -165, pos_z: -189, angle_z: 180, cell_id: '0x162e2' };
    assert.deepEqual(loginLocation(row), { pos: [35, -165, -189], rot: [0, 0, 180], cellOrWorldDesc: '162e2:Skyrim.esm' });
    assert.equal(loginLocation({ ...row, cell_id: 'garbage' }), null);
    assert.equal(loginLocation({ ...row, pos_x: null }), null);
    assert.deepEqual(loginLocation({ ...row, angle_z: null }).rot, [0, 0, 0]);
  });

  it('refuses a saved cell that is not a CELL or WRLD record', () => {
    const records = { 0x162e2: {}, 0x1605e: { record: { type: 'CELL' } }, 0x3c: { record: { type: 'WRLD' } } };
    const mpApi = {
      getIdFromDesc: (desc) => parseInt(desc.split(':')[0], 16),
      lookupEspmRecordById: (id) => records[id] || {}
    };
    const isCell = cellCheckerFor(mpApi);
    const row = { pos_x: 1, pos_y: 2, pos_z: 3, angle_z: 0, cell_id: '162e2:Skyrim.esm' };
    assert.equal(loginLocation(row, null, isCell), null, '162e2 is an object in the Blue Palace, not a cell');
    assert.equal(loginLocation({ ...row, cell_id: '1605e:Skyrim.esm' }, null, isCell).cellOrWorldDesc, '1605e:Skyrim.esm');
    assert.equal(loginLocation({ ...row, cell_id: '3c:Skyrim.esm' }, null, isCell).cellOrWorldDesc, '3c:Skyrim.esm');
    assert.equal(cellCheckerFor({ getIdFromDesc: () => { throw new Error('x'); }, lookupEspmRecordById: () => ({}) })('1:Skyrim.esm'), true,
      'a failed lookup must not strand the player');
    assert.equal(cellCheckerFor(undefined), null);
  });
});

describe('alreadyAt', () => {
  const target = { pos: [-977, 9, 5], rot: [0, 0, 137], cellOrWorldDesc: '133c6:Skyrim.esm' };

  it('same cell within reach: no teleport needed', () => {
    assert.equal(alreadyAt({ pos: [-960, 20, 5], cellOrWorldDesc: '133C6:Skyrim.esm' }, target), true);
  });

  it('another cell or too far: teleport', () => {
    assert.equal(alreadyAt({ pos: [-977, 9, 5], cellOrWorldDesc: '1a26f:Skyrim.esm' }, target), false);
    assert.equal(alreadyAt({ pos: [-500, 9, 5], cellOrWorldDesc: '133c6:Skyrim.esm' }, target), false);
  });

  it('unknown current location: teleport', () => {
    assert.equal(alreadyAt(null, target), false);
    assert.equal(alreadyAt({ cellOrWorldDesc: '133c6:Skyrim.esm' }, target), false);
  });
});
