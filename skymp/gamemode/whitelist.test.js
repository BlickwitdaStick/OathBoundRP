const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');

const queries = [];
// Open-server tests flip this: no whitelist row and no character yet.
const fresh = { on: false, approved: false, anyChars: 0 };
const restoredActors = [];
const realPositionPersistence = require('./core/position-persistence');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === './database') {
    return {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/FROM accounts a\s+WHERE a\.id = \?/i.test(sql)) {
          return [{ id: 42, status: 'active', vip_level: 0 }];
        }
        if (/FROM whitelist_applications/i.test(sql)) return fresh.on && !fresh.approved ? [] : [{ status: 'approved' }];
        if (fresh.on && /SELECT COUNT\(\*\) AS n FROM characters/i.test(sql)) return [{ n: fresh.anyChars }];
        if (fresh.on && /FROM discord_identities/i.test(sql)) return [{ username: 'xX_frost99_Xx' }];
        if (fresh.on && /INSERT INTO characters/i.test(sql)) return { insertId: 99 };
        if (fresh.on && /SELECT * FROM characters WHERE id = ?/i.test(sql)) {
          return [{ id: 99, first_name: 'XXfrostXx', last_name: 'Unnamed', pos_x: -977, pos_y: 9, pos_z: 5, angle_z: 137, cell_id: '133c6:Skyrim.esm' }];
        }
        if (fresh.on && /FROM characters/i.test(sql)) return [];
        if (/FROM characters/i.test(sql)) {
          return [{ id: 7, first_name: 'Alvara', last_name: 'Dawnmere', pos_x: 0, pos_y: 0, pos_z: 0, angle_z: 0, cell_id: '0x3c' }];
        }
        return [];
      }
    };
  }
  if (request === './commands') return { registerActiveCharacter: () => {} };
  if (request === './inventory-service') return { syncInventoryToClient: async () => {} };
  if (request === './admin-service') return { registerStaffRole: async () => {} };
  if (request === './core/character-state') return { initialize: async () => {} };
  if (request === './core/server-options') return { get: () => 0 };
  if (request === './core/transaction-service') return { addGold: async () => {} };
  if (request === './core/module-registry') return { isEnabled: () => false };
  return originalLoad.apply(this, arguments);
};

const whitelist = require('./whitelist');
Module._load = originalLoad;

beforeEach(() => {
  queries.length = 0;
});

after(() => {
  delete global.mp;
});

test('whitelist resolves online profileId directly as accounts.id', async () => {
  const allowed = await whitelist.checkWhitelist(1, 42, 0xff000001);

  assert.equal(allowed, true);
  const accountLookup = queries.find(({ sql }) => /FROM accounts a\s+WHERE a\.id = \?/i.test(sql));
  assert.deepEqual(accountLookup.params, [42]);
  assert.equal(
    queries.some(({ sql }) => /discord_identities|d\.discord_id/i.test(sql)),
    false,
    'the gamemode must not interpret profileId as a Discord ID'
  );
});

test('profile contract accepts only a positive safe integer', () => {
  assert.equal(whitelist.accountIdFromProfileId(42), 42);
  assert.equal(whitelist.accountIdFromProfileId('42'), 42);
  assert.equal(whitelist.accountIdFromProfileId(0), null);
  assert.equal(whitelist.accountIdFromProfileId('discord-id'), null);
});

test('local auto-whitelist persists the canonical spawn FormDesc', () => {
  const source = fs.readFileSync(require.resolve('./whitelist'), 'utf8');
  assert.match(source, /cell_id: '133c6:Skyrim.esm'/);
  assert.doesNotMatch(source, /cell_id: '0x162e2'/);
});

test('login teleport sends the saved cell as id:plugin, never a bare id (actor frozen in a nonexistent cell)', async () => {
  const sets = [];
  global.mp = {
    set: (id, key, value) => sets.push({ id, key, value }),
    getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
    kick: () => {}
  };
  restoredActors.length = 0;
  // whitelist.js requires this module lazily (same cached object), so patch it.
  const realGetInstance = realPositionPersistence.getInstance;
  realPositionPersistence.getInstance = () => ({ markRestored: (id) => restoredActors.push(id) });
  try {
    assert.equal(await whitelist.checkWhitelist(1, 42, 0xff000001), true);
  } finally {
    delete global.mp;
    realPositionPersistence.getInstance = realGetInstance;
  }
  const teleport = sets.find((s) => s.key === 'locationalData');
  assert.ok(teleport, 'the character is moved to its saved location');
  assert.deepEqual(teleport.value, { pos: [0, 0, 0], rot: [0, 0, 0], cellOrWorldDesc: '3c:Skyrim.esm' });
  assert.deepEqual(restoredActors, [0xff000001], 'position saving starts after the teleport');
});

test('whitelist on (the default): no approved application means a kick', async () => {
  const kicks = [];
  global.mp = { kick: (id) => kicks.push(id), set() {} };
  fresh.on = true;
  delete process.env.WHITELIST_REQUIRED;
  try {
    assert.equal(await whitelist.checkWhitelist(5, 42, 0xff000005), false);
    assert.deepEqual(kicks, [5]);
  } finally {
    fresh.on = false;
    delete global.mp;
  }
});

test('WHITELIST_REQUIRED=false: a first login gets a character named after Discord, last name Unnamed', async () => {
  const kicks = [];
  global.mp = { kick: (id) => kicks.push(id), set() {}, getDescFromId: (id) => id.toString(16) + ':Skyrim.esm' };
  fresh.on = true;
  process.env.WHITELIST_REQUIRED = 'false';
  try {
    assert.equal(await whitelist.checkWhitelist(6, 42, 0xff000006), true);
    assert.deepEqual(kicks, []);
    const insert = queries.find(({ sql }) => /INSERT INTO characters/i.test(sql));
    assert.deepEqual(insert.params, [42, 'XXfrostXx', 'Unnamed']);
  } finally {
    fresh.on = false;
    delete process.env.WHITELIST_REQUIRED;
    delete global.mp;
  }
});

test('whitelist on: whitelisted with no character at all (Discord role) gets a first character', async () => {
  const kicks = [];
  global.mp = { kick: (id) => kicks.push(id), set() {}, getDescFromId: (id) => id.toString(16) + ':Skyrim.esm' };
  Object.assign(fresh, { on: true, approved: true, anyChars: 0 });
  delete process.env.WHITELIST_REQUIRED;
  try {
    assert.equal(await whitelist.checkWhitelist(7, 42, 0xff000007), true);
    assert.deepEqual(kicks, []);
    assert.ok(queries.some(({ sql }) => /INSERT INTO characters/i.test(sql)));
  } finally {
    Object.assign(fresh, { on: false, approved: false, anyChars: 0 });
    delete global.mp;
  }
});

test('whitelist on: a retired character still needs a new application', async () => {
  const kicks = [];
  global.mp = { kick: (id) => kicks.push(id), set() {} };
  Object.assign(fresh, { on: true, approved: true, anyChars: 1 });
  delete process.env.WHITELIST_REQUIRED;
  try {
    assert.equal(await whitelist.checkWhitelist(8, 42, 0xff000008), false);
    assert.deepEqual(kicks, [8]);
    assert.ok(!queries.some(({ sql }) => /INSERT INTO characters/i.test(sql)));
  } finally {
    Object.assign(fresh, { on: false, approved: false, anyChars: 0 });
    delete global.mp;
  }
});
