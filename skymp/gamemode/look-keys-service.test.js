const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const commands = require('./commands');
const { createGroups, MAX_MEMBERS } = require('./core/groups');
const lookKeys = require('./look-keys-service');

const A = 0xff000001;
const B = 0xff000002;
const C = 0xff000003;
const DOOR = 0x0010abcd;

const notes = [];
const chars = new Map([[A, { characterId: 1 }], [B, { characterId: 2 }], [C, { characterId: 3 }]]);
commands.getActiveCharacterData = (id) => chars.get(id) || null;
commands.sendNotification = (id, msg) => notes.push([id, msg]);
commands.getDisplayNameForObserver = (id) => `P${id & 0xf}`;

function fakeHoldstones({ locked = true, ownerCharacterId = 1, minRankId = null } = {}) {
  const parcel = { id: 7, orgId: 'whiterun', holdId: 'whiterun', name: 'House', ownerCharacterId, minRankId, locked };
  const calls = [];
  return {
    calls,
    parcel,
    getIndex: () => ({
      objectsById: new Map([[DOOR, { formId: DOOR, parcelId: 7, kind: 'door', locks: true }]]),
      parcels: new Map([[7, parcel]]),
      ranks: new Map(),
      members: new Map()
    }),
    setParcelLocked: async (id, l) => { calls.push([id, l]); parcel.locked = l; return { ok: true, message: l ? 'locked' : 'unlocked' }; }
  };
}

beforeEach(() => {
  notes.length = 0;
  lookKeys._resetForTest();
});

test('groups: G invites, G back joins, a third joins the same group', () => {
  const g = createGroups();
  assert.equal(g.pressGroup(A, B).result, 'invited');
  const r = g.pressGroup(B, A);
  assert.equal(r.result, 'joined');
  assert.ok(g.sameGroup(A, B));
  assert.equal(g.pressGroup(A, C).result, 'invited');
  assert.equal(g.pressGroup(C, A).result, 'joined');
  assert.deepEqual(g.membersOf(C).sort(), [A, B, C].sort());
  assert.equal(g.pressGroup(A, B).result, 'already');
});

test('groups: leaving down to one member dissolves the group', () => {
  const g = createGroups();
  g.pressGroup(A, B); g.pressGroup(B, A);
  assert.deepEqual(g.leave(A), [B]);
  assert.equal(g.membersOf(B).length, 0);
});

test('groups: a full group refuses more members', () => {
  const g = createGroups();
  const ids = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => 0xff000100 + i);
  for (let i = 1; i < MAX_MEMBERS; i++) { g.pressGroup(ids[0], ids[i]); g.pressGroup(ids[i], ids[0]); }
  assert.equal(g.membersOf(ids[0]).length, MAX_MEMBERS);
  assert.equal(g.pressGroup(ids[0], ids[MAX_MEMBERS]).result, 'full', 'no invite out of a full group');
});

test('prompt on a player: E Trade, I Introduce, G Group up / Join group', () => {
  lookKeys.configure({ trade: {}, holdstones: null });
  let p = lookKeys.promptFor(A, B);
  assert.equal(p.kind, 'player');
  assert.deepEqual(p.keys.map((k) => k.key), ['E', 'I', 'G']);
  assert.equal(p.keys[2].label, 'Group up');
  lookKeys.groups.pressGroup(B, A);
  p = lookKeys.promptFor(A, B);
  assert.equal(p.keys[2].label, 'Join group');
});

test('door G (lock/unlock) shows only for players with parcel access', () => {
  const hs = fakeHoldstones({ locked: true, ownerCharacterId: 1 });
  lookKeys.configure({ trade: {}, holdstones: hs });
  global.mp = { get: () => '1234:Skyrim.esm', getIdFromDesc: () => 0x1234 };
  const espm = require('./core/espm');
  const old = espm.lookup;
  espm.lookup = () => ({ type: 'DOOR' });
  try {
    const owner = lookKeys.promptFor(A, DOOR);
    assert.deepEqual(owner.keys.map((k) => `${k.key}:${k.label}`), ['E:Open / close', 'G:Unlock']);
    const stranger = lookKeys.promptFor(B, DOOR);
    assert.deepEqual(stranger.keys.map((k) => k.key), ['E']);
  } finally {
    espm.lookup = old;
    delete global.mp;
  }
});

test('door G toggles the parcel lock; a stranger pressing G does nothing', async () => {
  const hs = fakeHoldstones({ locked: true, ownerCharacterId: 1 });
  lookKeys.configure({ trade: {}, holdstones: hs });
  global.mp = { get: () => '1234:Skyrim.esm', getIdFromDesc: () => 0x1234, set: () => {} };
  const espm = require('./core/espm');
  const old = espm.lookup;
  espm.lookup = () => ({ type: 'DOOR' });
  try {
    await lookKeys.handleKey(B, 'G', DOOR);
    assert.deepEqual(hs.calls, []);
    await lookKeys.handleKey(A, 'G', DOOR);
    assert.deepEqual(hs.calls, [[7, false]]);
  } finally {
    espm.lookup = old;
    delete global.mp;
  }
});

test('E on a player requests a trade, or accepts theirs', async () => {
  const calls = [];
  const sessions = new Map();
  const trade = {
    STATES: { REQUESTED: 'requested' },
    _sessionOf: (id) => sessions.get(id) || null,
    requestTrade: (a, b) => calls.push(['request', a, b]),
    acceptTrade: (a) => calls.push(['accept', a])
  };
  lookKeys.configure({ trade, holdstones: null });
  await lookKeys.handleKey(A, 'E', B);
  sessions.set(B, { state: 'requested', a: { actorId: A }, b: { actorId: B } });
  await lookKeys.handleKey(B, 'E', A);
  assert.deepEqual(calls, [['request', A, B], ['accept', B]]);
});

test('G on players sends the invite and the join notices', async () => {
  lookKeys.configure({ trade: {}, holdstones: null });
  await lookKeys.handleKey(A, 'G', B);
  assert.ok(notes.some(([id, m]) => id === B && /wants to group up/.test(m)));
  await lookKeys.handleKey(B, 'G', A);
  assert.ok(lookKeys.groups.sameGroup(A, B));
  assert.ok(notes.some(([id, m]) => id === A && /joined your group/.test(m)));
});

test('keys not on the prompt are ignored (I on a door)', async () => {
  const hs = fakeHoldstones();
  lookKeys.configure({ trade: {}, holdstones: hs });
  await lookKeys.handleKey(A, 'I', DOOR);
  assert.deepEqual(hs.calls, []);
});

test('client snippets are valid JavaScript', () => {
  for (const src of [lookKeys.SOURCE_SNIPPET, lookKeys.PROMPT_UPDATE_OWNER, lookKeys.COMPASS_UPDATE_OWNER]) {
    assert.doesNotThrow(() => new Function('ctx', src));
  }
});

test('compass snippet turns positions into bearings relative to facing', () => {
  let js = null;
  const ctx = {
    state: {},
    value: { members: [{ name: 'East', x: 1000, y: 0 }, { name: 'North', x: 0, y: 1000 }] },
    sp: {
      browser: { executeJavaScript: (s) => { js = s; } },
      Game: { getPlayer: () => ({ getPositionX: () => 0, getPositionY: () => 0, getAngleZ: () => 90 }) }
    }
  };
  new Function('ctx', lookKeys.COMPASS_UPDATE_OWNER)(ctx);
  const list = JSON.parse(js.slice(js.indexOf('(') + 1, js.lastIndexOf(')')));
  assert.equal(list.find((m) => m.name === 'East').rel, 0);
  assert.equal(list.find((m) => m.name === 'North').rel, -90);
});
