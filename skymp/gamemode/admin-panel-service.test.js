/**
 * admin-panel-service.test.js
 *
 * The F8 admin panel, server side, with the REAL admin-service, commands and
 * character-numbers modules over a fake database:
 *   - permission checks: non-staff get nothing; each tab's action needs its
 *     own permission (a moderator can kick but not retire, give or spawn);
 *   - retiring a character that is OFFLINE (and online), once, with a reason;
 *   - item search (index and the FormID fallback) and giving by #number;
 *   - number targeting for every player action;
 *   - creature spawning: availability, record type, position, audit, removal.
 *
 * Does NOT prove the panel works in game (CEF, SkyMP property, mp.place):
 * see docs/admin/F8_ADMIN_PANEL.md for what to verify there.
 *
 * Run: node --test admin-panel-service.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

// ── fake world ──────────────────────────────────────────────────────────────
const staffRoles = new Map();     // accountId -> role
const characters = new Map();     // id -> row
const audit = [];                 // { action, actorAccount, targetAccount, details }
const queries = [];
const given = [];                 // transaction-service.giveItem payloads
let gold = 100;

function dbQuery(sql, params = []) {
  queries.push({ sql, params });
  if (/SELECT role FROM staff_roles/i.test(sql)) {
    const role = staffRoles.get(params[0]);
    return role ? [{ role }] : [];
  }
  if (/FROM characters WHERE id = \? LIMIT 1/i.test(sql)) {
    const row = characters.get(params[0]);
    return row ? [{ ...row }] : [];
  }
  if (/UPDATE characters SET status = \? WHERE id = \? AND status <> 'retired'/i.test(sql)) {
    const row = characters.get(params[1]);
    if (!row || row.status === 'retired') return { affectedRows: 0 };
    row.status = params[0];
    return { affectedRows: 1 };
  }
  if (/UPDATE characters SET char_number = NULL/i.test(sql)) {
    const row = characters.get(params[0]);
    if (row) row.char_number = null;
    return { affectedRows: 1 };
  }
  if (/INSERT INTO audit_logs/i.test(sql)) {
    audit.push({ action: params[0], actorAccount: params[1], targetAccount: params[2], details: params[3] });
    return {};
  }
  if (/FROM characters c/i.test(sql)) {
    return [...characters.values()]
      .filter((r) => /status <> 'retired'/.test(sql) ? r.status !== 'retired' : true)
      .map((r) => ({ ...r, account_name: `user${r.account_id}` }));
  }
  return [];
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database') {
    return { init: () => {}, query: async (sql, params) => dbQuery(sql, params) };
  }
  if (request === './core/transaction-service' || request.endsWith('/core/transaction-service')) {
    return {
      giveItem: async (p) => { given.push(p); return true; },
      getGold: async () => gold,
      addGold: async ({ amount }) => { gold += amount; return true; },
      removeGold: async ({ amount }) => { gold -= amount; return true; }
    };
  }
  return originalLoad.apply(this, arguments);
};

const commands = require('./commands');
const admin = require('./admin-service');
const characterNumbers = require('./core/character-numbers');
const { createAdminPanel, applyDefaultFlag, PROPERTY, MAX_LIVE_SPAWNS } = require('./admin-panel-service');

// ── actors ──────────────────────────────────────────────────────────────────
const STAFF = 0xff000101;    // account 1, character #1
const PLAYER = 0xff000102;   // account 2, character #5
const OTHER = 0xff000103;    // account 3, character #6

function login(actorId, id, accountId, number, first, last) {
  characters.set(id, { id, account_id: accountId, first_name: first, last_name: last, status: 'approved', char_number: number });
  commands.registerActiveCharacter(actorId, { id, first_name: first, last_name: last, char_number: number }, accountId, 1);
}

// ── fakes for the panel ─────────────────────────────────────────────────────
const RECORDS = [
  { baseId: 0x12eb7, idHex: '0x00012eb7', type: 'WEAP', name: 'Iron Sword', editorId: 'IronSword', plugin: 'Skyrim.esm' },
  { baseId: 0x23ab7, idHex: '0x00023ab7', type: 'NPC_', name: 'Wolf', editorId: 'EncWolf', plugin: 'Skyrim.esm' }
];

function fakeIndex({ available = true } = {}) {
  const calls = [];
  return {
    calls,
    status: () => (available ? { status: 'ready', count: RECORDS.length, error: null } : { status: 'unavailable', count: 0, error: 'no settings' }),
    get: async () => (available ? {} : null),
    search: async (q) => {
      calls.push(q);
      if (!available) return null;
      return RECORDS.filter((r) => q.types.includes(r.type) && r.name.toLowerCase().includes(String(q.query).toLowerCase()));
    },
    searchPage: async (q) => {
      calls.push(q);
      if (!available) return null;
      const all = RECORDS.filter((r) => q.types.includes(r.type) && r.name.toLowerCase().includes(String(q.query).toLowerCase()));
      return { results: all, total: all.length, offset: q.offset || 0, limit: 50 };
    },
    findById: async (id) => (available ? RECORDS.find((r) => r.baseId === id) || null : null)
  };
}

const fakeEspm = {
  lookup: (id) => (id === 0x12eb7 ? { existe: true, type: 'WEAP', editorId: 'IronSword' }
    : id === 0x23ab7 ? { existe: true, type: 'NPC_', editorId: 'EncWolf' }
      : { existe: false, type: null, editorId: null })
};

function fakeMp({ npcEnabled = true, place = true } = {}) {
  const props = [];
  let nextForm = 0xff100000;
  const api = {
    props,
    destroyed: [],
    set: (id, name, value) => props.push({ id, name, value }),
    get: (id, name) => (name === 'locationalData' ? { pos: [1000, 2000, 300], rot: [0, 0, 90], cellOrWorldDesc: '3c:Skyrim.esm' } : null),
    getServerSettings: () => ({ npcEnabled }),
    destroyActor: (id) => api.destroyed.push(id)
  };
  if (place) api.place = () => ++nextForm;
  return api;
}

const silent = { log: () => {}, error: () => {} };

function makePanel(opts = {}) {
  const mpApi = opts.mp || fakeMp();
  const recordIndex = opts.index || fakeIndex();
  const panel = createAdminPanel({
    db: { query: async (sql, params) => dbQuery(sql, params) },
    commands, admin, characterNumbers, recordIndex, espm: fakeEspm,
    mpApi: () => mpApi,
    log: silent
  });
  return { panel, mp: mpApi, index: recordIndex };
}

/** Latest channels the page would have received for an actor. */
function channelsOf(mpApi, actorId) {
  const sets = mpApi.props.filter((p) => p.id === actorId && p.name === PROPERTY);
  return sets.length ? sets[sets.length - 1].value.channels : {};
}

function lastResult(mpApi, actorId) {
  return channelsOf(mpApi, actorId).result || null;
}

async function asRole(role) {
  admin.removeStaffRole(STAFF);
  if (role) staffRoles.set(1, role); else staffRoles.delete(1);
  await admin.registerStaffRole(STAFF, 1);
}

beforeEach(async () => {
  for (const actorId of commands.listActiveActorIds()) commands.removeActiveCharacter(actorId);
  characters.clear();
  staffRoles.clear();
  audit.length = 0;
  queries.length = 0;
  given.length = 0;
  gold = 100;
  login(STAFF, 10, 1, 1, 'Staff', 'Member');
  login(PLAYER, 11, 2, 5, 'Ralof', 'Stormcloak');
  login(OTHER, 12, 3, 6, 'Hadvar', 'Legion');
  await asRole('admin');
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin panel: permission checks', () => {
  it('a non-staff player opening the panel gets "denied" and no data', async () => {
    await asRole(null);
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(PLAYER, { type: 'admin:open' });
    const ch = channelsOf(mp, PLAYER);
    assert.deepStrictEqual(ch.meta, { denied: true });
    assert.strictEqual(ch.characters, undefined);
    assert.strictEqual(ch.players, undefined);
  });

  it('non-staff cannot run any admin action, whatever the UI sends', async () => {
    await asRole(null);
    const { panel, mp } = makePanel();
    const attempts = [
      ['admin:characters:search', {}],
      ['admin:characters:retire', { characterId: 12, reason: 'x' }],
      ['admin:items:give', { baseId: 0x12eb7, count: 5, target: 'self' }],
      ['admin:creatures:spawn', { baseId: 0x23ab7 }],
      ['admin:players:kick', { number: 6, reason: 'x' }],
      ['admin:players:setgold', { number: 6, amount: 1 }],
      ['admin:players:goto', { number: 6 }]
    ];
    for (const [type, data] of attempts) {
      assert.strictEqual(await panel.handleUiEvent(PLAYER, { type, data }), true, type);
    }
    assert.deepStrictEqual(audit, []);
    assert.deepStrictEqual(given, []);
    assert.strictEqual(characters.get(12).status, 'approved');
    assert.deepStrictEqual(mp.props.filter((p) => p.name === 'locationalData'), []);
  });

  it('meta tells the page what the role can do', async () => {
    await asRole('moderator');
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:open' });
    const { meta } = channelsOf(mp, STAFF);
    assert.strictEqual(meta.role, 'moderator');
    assert.deepStrictEqual(meta.can, { retire: false, giveItem: false, spawnNpc: false, teleport: true, setGold: false, kick: true });
    assert.strictEqual(typeof meta.openSeq, 'number');
  });

  it('a moderator is refused retire, give and spawn on the server, even if the UI sends them', async () => {
    await asRole('moderator');
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 12, reason: 'rdm' } });
    assert.match(lastResult(mp, STAFF).message, /Permission denied/);
    await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 0x12eb7, count: 1 } });
    assert.match(lastResult(mp, STAFF).message, /Permission denied/);
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    assert.match(lastResult(mp, STAFF).message, /Permission denied/);
    assert.strictEqual(characters.get(12).status, 'approved');
    assert.deepStrictEqual(given, []);
    assert.ok(!audit.some((a) => a.action === 'staff:spawnNpc'));
  });

  it('a moderator can kick (with a reason) and it is audited', async () => {
    await asRole('moderator');
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:players:kick', data: { number: 6, reason: 'fail RP' } });
    assert.strictEqual(lastResult(mp, STAFF).ok, true);
    const entry = audit.find((a) => a.action === 'staff:kick');
    assert.ok(entry);
    assert.strictEqual(entry.targetAccount, 3);
    assert.match(entry.details, /reason=fail RP/);
  });

  it('spawn_npc is an admin/owner permission, not a moderator one', async () => {
    for (const [role, expected] of [['moderator', false], ['admin', true], ['owner', true]]) {
      admin.removeStaffRole(0xff00ffff);
      staffRoles.set(99, role);
      await admin.registerStaffRole(0xff00ffff, 99);
      assert.strictEqual(admin.hasPermission(0xff00ffff, 'spawn_npc'), expected, role);
    }
    admin.removeStaffRole(0xff00ffff);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin panel: characters tab and offline retire', () => {
  it('lists every character, online and offline, with number, account and status', async () => {
    characters.set(50, { id: 50, account_id: 9, first_name: 'Offline', last_name: 'Person', status: 'approved', char_number: 33 });
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:open' });
    const list = channelsOf(mp, STAFF).characters.characters;
    const offline = list.find((c) => c.characterId === 50);
    assert.deepStrictEqual(offline, { characterId: 50, number: 33, name: 'Offline Person', status: 'approved', accountId: 9, accountName: 'user9', online: false });
    assert.strictEqual(list.find((c) => c.characterId === 11).online, true);
  });

  it('search by number filters on #number, character id or account id; text uses LIKE with escaped wildcards', async () => {
    const { panel } = makePanel();
    await panel.searchCharacters({ query: '#12' });
    let q = queries.filter((x) => /FROM characters c/.test(x.sql)).pop();
    assert.match(q.sql, /c\.char_number = \? OR c\.id = \? OR c\.account_id = \?/);
    assert.deepStrictEqual(q.params, [12, 12, 12]);
    assert.match(q.sql, /status <> 'retired'/);

    await panel.searchCharacters({ query: '50%_off', includeRetired: true });
    q = queries.filter((x) => /FROM characters c/.test(x.sql)).pop();
    assert.deepStrictEqual(q.params, ['%50\\%\\_off%', '%50\\%\\_off%']);
    assert.doesNotMatch(q.sql, /status <> 'retired'/);
  });

  it('retires an OFFLINE character: status, number released, audit, no kick', async () => {
    characters.set(50, { id: 50, account_id: 9, first_name: 'Offline', last_name: 'Person', status: 'approved', char_number: 33 });
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 50, reason: '  confirmed RDM  ' } });
    assert.strictEqual(characters.get(50).status, 'retired');
    assert.strictEqual(characters.get(50).char_number, null, '#33 released');
    const entry = audit.find((a) => a.action === 'staff:retireCharacter');
    assert.ok(entry);
    assert.strictEqual(entry.actorAccount, 1);
    assert.strictEqual(entry.targetAccount, 9);
    assert.match(entry.details, /characterId=50 number=33 online=no via=f8 reason=confirmed RDM$/);
    const r = lastResult(mp, STAFF);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'Offline Person was retired.');
    assert.ok(!channelsOf(mp, STAFF).characters.characters.some((c) => c.characterId === 50), 'list refreshed without the retired one');
  });

  it('retiring an ONLINE character says it will be kicked and audits online=yes', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 11, reason: 'perma' } });
    assert.strictEqual(characters.get(11).status, 'retired');
    assert.match(lastResult(mp, STAFF).message, /will be kicked/);
    assert.match(audit.find((a) => a.action === 'staff:retireCharacter').details, /online=yes/);
  });

  it('a reason is required; already retired and unknown characters are refused, once', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 12, reason: '   ' } });
    assert.match(lastResult(mp, STAFF).message, /reason is required/);
    assert.strictEqual(characters.get(12).status, 'approved');

    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 12, reason: 'one' } });
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 12, reason: 'two' } });
    assert.match(lastResult(mp, STAFF).message, /already retired/);
    assert.strictEqual(audit.filter((a) => a.action === 'staff:retireCharacter').length, 1);

    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 999, reason: 'x' } });
    assert.match(lastResult(mp, STAFF).message, /not found/);
    await panel.handleUiEvent(STAFF, { type: 'admin:characters:retire', data: { characterId: 'DROP TABLE', reason: 'x' } });
    assert.match(lastResult(mp, STAFF).message, /Invalid character/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin panel: item search and give', () => {
  it('search asks the index for item types only (never NPCs) and returns results', async () => {
    const { panel, mp, index } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: 'iron' } });
    assert.ok(!index.calls[0].types.includes('NPC_'));
    assert.deepStrictEqual(channelsOf(mp, STAFF).items.results.map((r) => r.name), ['Iron Sword']);
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: 'wolf' } });
    assert.deepStrictEqual(channelsOf(mp, STAFF).items.results, []);
  });

  it('a category narrows the search to that type; the page offset reaches the index', async () => {
    const { panel, mp, index } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: '', type: 'ARMO', offset: 100 } });
    assert.deepStrictEqual(index.calls[0].types, ['ARMO']);
    assert.strictEqual(index.calls[0].offset, 100);
    const items = channelsOf(mp, STAFF).items;
    assert.strictEqual(items.type, 'ARMO');
    assert.strictEqual(items.offset, 100);
    assert.strictEqual(items.pageSize, 50);
    assert.strictEqual(typeof items.total, 'number');
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: '', offset: -5 } });
    assert.strictEqual(index.calls[1].offset, 0, 'junk offsets become page 1');
  });

  it('an unknown type filter falls back to all item types', async () => {
    const { panel, index } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: 'x', type: 'NPC_' } });
    assert.ok(!index.calls[0].types.includes('NPC_'));
    assert.ok(index.calls[0].types.includes('WEAP'));
  });

  it('without an index, a FormID still finds the item (and says why names do not)', async () => {
    const { panel, mp } = makePanel({ index: fakeIndex({ available: false }) });
    await panel.handleUiEvent(STAFF, { type: 'admin:items:search', data: { query: '0x00012eb7' } });
    const items = channelsOf(mp, STAFF).items;
    assert.match(items.note, /Search by name is unavailable/);
    assert.deepStrictEqual(items.results.map((r) => r.baseId), [0x12eb7]);
  });

  it('gives N to yourself, audited through giveItemAdmin', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 0x12eb7, count: 3, target: 'self' } });
    assert.deepStrictEqual(given.map((g) => [g.actorId, g.characterId, g.baseId, g.count]), [[STAFF, 10, 0x12eb7, 3]]);
    assert.ok(audit.some((a) => a.action === 'staff:addItem' && /count=3/.test(a.details)));
    assert.strictEqual(lastResult(mp, STAFF).ok, true);
  });

  it('count must be 1..1000 and the item id valid', async () => {
    const { panel, mp } = makePanel();
    for (const count of [0, -1, 1.5, 1001, 'many']) {
      await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 0x12eb7, count } });
      assert.match(lastResult(mp, STAFF).message, /Count must be/, String(count));
    }
    await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 'abc', count: 1 } });
    assert.match(lastResult(mp, STAFF).message, /Invalid item/);
    assert.deepStrictEqual(given, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin panel: number targeting', () => {
  it('resolvePlayer accepts 5 and #5, refuses offline numbers and junk', () => {
    const { panel } = makePanel();
    assert.deepStrictEqual(panel.resolvePlayer('#5'), { actorId: PLAYER });
    assert.deepStrictEqual(panel.resolvePlayer(5), { actorId: PLAYER });
    assert.deepStrictEqual(panel.resolvePlayer('#99'), { error: 'No one with number #99 is online.' });
    assert.match(panel.resolvePlayer('ff000102').error, /not a character number/);
    assert.match(panel.resolvePlayer('').error, /not a character number/);
    assert.match(panel.resolvePlayer('0').error, /not a character number/);
  });

  it('give to #6 lands on that player, never on the staff member', async () => {
    const { panel } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 0x12eb7, count: 1, target: '#6' } });
    assert.deepStrictEqual(given.map((g) => g.actorId), [OTHER]);
    assert.strictEqual(audit.find((a) => a.action === 'staff:addItem').targetAccount, 3);
  });

  it('give to an offline number gives nothing', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:items:give', data: { baseId: 0x12eb7, count: 1, target: '#40' } });
    assert.deepStrictEqual(given, []);
    assert.strictEqual(lastResult(mp, STAFF).message, 'No one with number #40 is online.');
  });

  it('go to / bring here / set gold / kick all target by number and are audited', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:players:goto', data: { number: 5 } });
    assert.match(audit.pop().details, new RegExp(`target=${PLAYER.toString(16)}`));
    await panel.handleUiEvent(STAFF, { type: 'admin:players:bring', data: { number: '#6' } });
    const bring = audit.pop();
    assert.strictEqual(bring.action, 'staff:bring');
    assert.strictEqual(bring.targetAccount, 3);
    await panel.handleUiEvent(STAFF, { type: 'admin:players:setgold', data: { number: 5, amount: 250 } });
    assert.strictEqual(gold, 250);
    assert.strictEqual(audit.pop().action, 'staff:setGold');
    await panel.handleUiEvent(STAFF, { type: 'admin:players:setgold', data: { number: 5, amount: -3 } });
    assert.match(lastResult(mp, STAFF).message, /whole number/);
    await panel.handleUiEvent(STAFF, { type: 'admin:players:kick', data: { number: 5, reason: '' } });
    assert.match(lastResult(mp, STAFF).message, /reason is required/);
    await panel.handleUiEvent(STAFF, { type: 'admin:players:goto', data: { number: 1 } });
    assert.strictEqual(lastResult(mp, STAFF).message, 'That is you.');
    assert.strictEqual(audit.length, 0, 'refused actions write nothing');
  });

  it('the players channel lists who is online by number', async () => {
    const { panel } = makePanel();
    const snap = panel.playersSnapshot();
    assert.deepStrictEqual(snap.players.map((p) => [p.number, p.name, p.staffRole]), [
      [1, 'Staff Member', 'admin'], [5, 'Ralof Stormcloak', null], [6, 'Hadvar Legion', null]
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin panel: creature spawning', () => {
  it('unavailable with a clear message when the server has NPCs disabled', async () => {
    const { panel, mp } = makePanel({ mp: fakeMp({ npcEnabled: false }) });
    assert.strictEqual(panel.npcSpawnAvailability().available, false);
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    assert.match(lastResult(mp, STAFF).message, /NPCs are disabled on this server/);
    assert.ok(!audit.some((a) => a.action === 'staff:spawnNpc'));
  });

  it('a missing npcEnabled counts as disabled (SkyMP default)', () => {
    const api = fakeMp();
    api.getServerSettings = () => ({});
    const { panel } = makePanel({ mp: api });
    assert.match(panel.npcSpawnAvailability().reason, /npcEnabled is not set/);
  });

  it('unavailable when the build has no mp.place', () => {
    const { panel } = makePanel({ mp: fakeMp({ place: false }) });
    assert.match(panel.npcSpawnAvailability().reason, /mp\.place/);
  });

  it('places an NPC_ 150 units in front of the staff member, facing them, and audits it', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    const placed = mp.props.find((p) => p.name === 'locationalData');
    assert.ok(placed);
    // Facing 90° (east): +X.
    assert.ok(Math.abs(placed.value.pos[0] - 1150) < 1e-6);
    assert.ok(Math.abs(placed.value.pos[1] - 2000) < 1e-6);
    assert.strictEqual(placed.value.pos[2], 300);
    assert.deepStrictEqual(placed.value.rot, [0, 0, 270]);
    assert.strictEqual(placed.value.cellOrWorldDesc, '3c:Skyrim.esm');
    const entry = audit.find((a) => a.action === 'staff:spawnNpc');
    assert.match(entry.details, /baseId=0x23ab7 formId=0xff100001/);
    assert.strictEqual(lastResult(mp, STAFF).message, 'Spawned Wolf in front of you.');
    assert.deepStrictEqual(channelsOf(mp, STAFF).spawned.list.map((s) => s.formId), [0xff100001]);
  });

  it('refuses records that are not NPC_ and unknown ids', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x12eb7 } });
    assert.match(lastResult(mp, STAFF).message, /is a WEAP, not an NPC/);
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x7777 } });
    assert.match(lastResult(mp, STAFF).message, /not a record/);
    assert.deepStrictEqual(mp.props.filter((p) => p.name === 'locationalData'), []);
  });

  it('removes only creatures spawned from the panel, audited', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:despawn', data: { formId: PLAYER } });
    assert.match(lastResult(mp, STAFF).message, /Only creatures spawned from this panel/);
    assert.deepStrictEqual(mp.destroyed, []);
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:despawn', data: { formId: 0xff100001 } });
    assert.deepStrictEqual(mp.destroyed, [0xff100001]);
    assert.ok(audit.some((a) => a.action === 'staff:despawnNpc'));
    assert.deepStrictEqual(channelsOf(mp, STAFF).spawned.list, []);
  });

  it(`caps live spawns at ${MAX_LIVE_SPAWNS}`, async () => {
    const { panel, mp } = makePanel();
    for (let i = 0; i < MAX_LIVE_SPAWNS; i++) {
      await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    }
    await panel.handleUiEvent(STAFF, { type: 'admin:creatures:spawn', data: { baseId: 0x23ab7 } });
    assert.match(lastResult(mp, STAFF).message, /Remove some first/);
  });
});

describe('admin panel: flag and plumbing', () => {
  it('ENABLE_ADMIN_PANEL defaults to true; an explicit false stays false', () => {
    const env = {};
    assert.strictEqual(applyDefaultFlag(env), 'true');
    assert.strictEqual(applyDefaultFlag({ ENABLE_ADMIN_PANEL: 'false' }), 'false');
  });

  it('close releases browser focus; unknown admin events are not claimed; other prefixes ignored', async () => {
    const { panel, mp } = makePanel();
    await panel.handleUiEvent(STAFF, { type: 'admin:close' });
    assert.ok(mp.props.some((p) => p.id === STAFF && p.name === 'browserFocused' && p.value === false));
    assert.strictEqual(await panel.handleUiEvent(STAFF, { type: 'admin:nope' }), false);
    assert.strictEqual(await panel.handleUiEvent(STAFF, { type: 'panel:open' }), false);
  });
});
