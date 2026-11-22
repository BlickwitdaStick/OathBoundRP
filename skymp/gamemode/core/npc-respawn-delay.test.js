const { test } = require('node:test');
const assert = require('node:assert');
const respawn = require('./npc-respawn-delay');

function fakeEvents() {
  const subs = new Map();
  return {
    subs,
    subscribe: (name, fn) => subs.set(name, fn),
    unsubscribe: (name) => subs.delete(name)
  };
}

test('a dead world NPC gets a 6-hour spawnDelay, and the respawn is not blocked', () => {
  const sets = [];
  const events = fakeEvents();
  respawn.start({ mpApi: { set: (id, prop, v) => sets.push([id, prop, v]) }, events, env: {}, logger: { log() {}, error() {} } });
  const handler = events.subs.get('npc-respawn-delay');
  assert.equal(handler(0x9b0db, 0xff000000), undefined);
  assert.deepEqual(sets, [[0x9b0db, 'spawnDelay', 6 * 3600]]);
});

test('player characters (server-made actors) are left alone', () => {
  const sets = [];
  const events = fakeEvents();
  respawn.start({ mpApi: { set: (...a) => sets.push(a) }, events, env: {}, logger: { log() {}, error() {} } });
  events.subs.get('npc-respawn-delay')(0xff000003, 0x9b0db);
  assert.deepEqual(sets, []);
});

test('NPC_RESPAWN_HOURS overrides the delay; nonsense falls back to 6 h', () => {
  assert.equal(respawn.respawnSeconds({ NPC_RESPAWN_HOURS: '0.5' }), 1800);
  assert.equal(respawn.respawnSeconds({ NPC_RESPAWN_HOURS: 'abc' }), 6 * 3600);
  assert.equal(respawn.respawnSeconds({ NPC_RESPAWN_HOURS: '-1' }), 6 * 3600);
});

test('a failing mp.set is logged, never thrown', () => {
  const events = fakeEvents();
  const errors = [];
  respawn.start({ mpApi: { set: () => { throw new Error('boom'); } }, events, env: {}, logger: { log() {}, error: (m) => errors.push(m) } });
  assert.equal(events.subs.get('npc-respawn-delay')(0x1234), undefined);
  assert.equal(errors.length, 1);
});
