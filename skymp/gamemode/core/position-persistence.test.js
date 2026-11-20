const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPositionPersistence, loadStartPoints, normalizeCell, MIN_MOVE } = require('./position-persistence');

const START = { pos: [35, -165, -189], cell: '162e2' };

describe('position persistence', () => {
  let queries, locs, chars, pp;
  const A = 0xff000001;

  beforeEach(() => {
    queries = [];
    locs = new Map([[A, { pos: [100, 200, 300], rot: [0, 0, 90], cellOrWorldDesc: '3c:Skyrim.esm' }]]);
    chars = new Map([[A, { characterId: 7 }]]);
    pp = createPositionPersistence({
      db: { query: async (sql, params) => { queries.push(params); return { affectedRows: 1 }; } },
      mpApi: { get: (id) => locs.get(id) },
      listActive: () => [...chars.keys()],
      getCharacter: (id) => chars.get(id) || null,
      startPoints: [START],
      logger: { error() {}, warn() {} }
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
    locs.set(A, { pos: START.pos.slice(), rot: [0, 0, 180], cellOrWorldDesc: '162e2' });
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
