const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createPositionPersistence, MIN_MOVE } = require('./position-persistence');

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
      logger: { error() {} }
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

  it('saves on logout even without movement, then forgets the actor', async () => {
    pp.markRestored(A);
    await pp.tick();
    await pp.onDisconnect(A);
    assert.equal(queries.length, 2);
    chars.delete(A);
    await pp.tick();
    assert.equal(queries.length, 2);
  });

  it('ignores an unreadable position instead of saving garbage', async () => {
    pp.markRestored(A);
    locs.set(A, { pos: [NaN, 0, 0], cellOrWorldDesc: '3c:Skyrim.esm' });
    await pp.tick();
    locs.set(A, null);
    await pp.tick();
    assert.equal(queries.length, 0);
  });
});
