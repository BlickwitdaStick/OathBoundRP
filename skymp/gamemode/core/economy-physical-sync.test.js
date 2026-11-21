'use strict';

/**
 * economy-physical-sync: inventory gold and characters.gold kept equal by a
 * three-way merge against `gold_synced`. Fakes: the server inventory (one
 * Gold001 count per actor), the balance (transaction-service) and the column.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, after } = require('node:test');

// core/papyrus builds refs with the global mp.getDescFromId.
global.mp = { getDescFromId: (id) => (id >= 0xff000000 ? (id - 0xff000000).toString(16) : `${id.toString(16)}:Skyrim.esm`) };
after(() => { delete global.mp; });
const { createGoldSync, GOLD_BASE_ID } = require('./economy-physical-sync');

const ACTOR = 0xff000010;
const CHAR = 10;

let inventory;   // actorId → Gold001 count
let balance;     // characterId → characters.gold
let synced;      // characterId → gold_synced (null = never)
let ledger;
let failNextBalance;
let failInventory;
let sync;

function fakeMp() {
  const goldArg = (a) => {
    assert.equal(a.type, 'espm', 'items go to Papyrus as baseRef');
    assert.equal(parseInt(String(a.desc).split(':')[0], 16), GOLD_BASE_ID);
  };
  return {
    callPapyrusFunction(kind, cls, fn, self, args) {
      goldArg(args[0]);
      if (fn === 'GetItemCount') return inventory.get(ACTOR) || 0;
      if (failInventory) throw new Error('papyrus down');
      if (fn === 'AddItem') inventory.set(ACTOR, (inventory.get(ACTOR) || 0) + args[1]);
      if (fn === 'RemoveItem') inventory.set(ACTOR, Math.max(0, (inventory.get(ACTOR) || 0) - args[1]));
      return undefined;
    }
  };
}

function fakeTransactions() {
  const change = (characterId, delta, reason) => {
    if (failNextBalance) { failNextBalance = false; return false; }
    const now = balance.get(characterId) || 0;
    if (now + delta < 0) return false;
    balance.set(characterId, now + delta);
    ledger.push({ characterId, delta, reason });
    return true;
  };
  return {
    getGold: async (id) => balance.get(id) || 0,
    addGold: async (o) => change(o.characterId, o.amount, o.reason),
    removeGold: async (o) => change(o.characterId, -o.amount, o.reason)
  };
}

function fakeDb() {
  return {
    async query(sql, p) {
      if (sql.startsWith('SELECT gold_synced')) return [{ gold_synced: synced.has(p[0]) ? synced.get(p[0]) : null }];
      if (sql.startsWith('UPDATE characters SET gold_synced')) { synced.set(p[1], p[0]); return {}; }
      throw new Error(`unexpected SQL ${sql}`);
    }
  };
}

beforeEach(() => {
  inventory = new Map();
  balance = new Map();
  synced = new Map();
  ledger = [];
  failNextBalance = false;
  failInventory = false;
  sync = createGoldSync({
    db: fakeDb(),
    mp: fakeMp(),
    transactions: fakeTransactions(),
    listActive: () => [ACTOR],
    getCharacter: () => ({ characterId: CHAR }),
    logger: { log() {}, warn() {}, error() {} }
  });
});

const state = () => ({ inventory: inventory.get(ACTOR) || 0, balance: balance.get(CHAR) || 0, synced: synced.get(CHAR) });

describe('economy-physical-sync: first login', () => {
  it('puts the virtual balance into the inventory', async () => {
    balance.set(CHAR, 5000);
    await sync.onLogin(ACTOR, CHAR);
    assert.deepEqual(state(), { inventory: 5000, balance: 5000, synced: 5000 });
    assert.deepEqual(ledger, [], 'the balance was already right');
  });

  it('gold already in the inventory is added to the balance, not deleted', async () => {
    balance.set(CHAR, 100);
    inventory.set(ACTOR, 30);
    await sync.onLogin(ACTOR, CHAR);
    assert.deepEqual(state(), { inventory: 130, balance: 130, synced: 130 });
    assert.deepEqual(ledger, [{ characterId: CHAR, delta: 30, reason: 'inventory_gold' }]);
  });
});

describe('economy-physical-sync: in game', () => {
  beforeEach(async () => {
    balance.set(CHAR, 100);
    await sync.onLogin(ACTOR, CHAR);
  });

  it('looting gold raises the balance', async () => {
    inventory.set(ACTOR, 175);
    await sync.tick();
    assert.deepEqual(state(), { inventory: 175, balance: 175, synced: 175 });
    assert.equal(ledger.at(-1).delta, 75);
  });

  it('dropping gold lowers the balance', async () => {
    inventory.set(ACTOR, 40);
    await sync.tick();
    assert.deepEqual(state(), { inventory: 40, balance: 40, synced: 40 });
  });

  it('a server payment reaches the inventory', async () => {
    balance.set(CHAR, 60); // bought something at a stall
    await sync.tick();
    assert.deepEqual(state(), { inventory: 60, balance: 60, synced: 60 });
    balance.set(CHAR, 260); // salary
    await sync.tick();
    assert.deepEqual(state(), { inventory: 260, balance: 260, synced: 260 });
  });

  it('looting and a payment in the same tick are both kept', async () => {
    inventory.set(ACTOR, 150); // +50 looted
    balance.set(CHAR, 80);     // -20 paid
    await sync.tick();
    assert.deepEqual(state(), { inventory: 130, balance: 130, synced: 130 });
  });

  it('spending more than there is ends at 0, never negative', async () => {
    inventory.set(ACTOR, 0);   // dropped all 100
    balance.set(CHAR, 50);     // and paid 50
    await sync.tick();
    assert.deepEqual(state(), { inventory: 0, balance: 0, synced: 0 });
  });

  it('nothing changes when both sides already agree', async () => {
    const before = ledger.length;
    await sync.tick();
    assert.equal(ledger.length, before);
    assert.deepEqual(state(), { inventory: 100, balance: 100, synced: 100 });
  });

  it('a failed balance change leaves everything for the next tick', async () => {
    inventory.set(ACTOR, 150);
    failNextBalance = true;
    await sync.tick();
    assert.deepEqual(state(), { inventory: 150, balance: 100, synced: 100 });
    await sync.tick();
    assert.deepEqual(state(), { inventory: 150, balance: 150, synced: 150 });
  });

  it('a failed inventory change is retried, and the gold is not read as spent', async () => {
    balance.set(CHAR, 300);
    failInventory = true;
    await sync.tick();
    assert.deepEqual(state(), { inventory: 100, balance: 300, synced: 100 });
    failInventory = false;
    await sync.tick();
    assert.deepEqual(state(), { inventory: 300, balance: 300, synced: 300 });
  });

  it('after logout the saved amount carries the merge into the next login', async () => {
    sync.onDisconnect(ACTOR);
    assert.equal(sync.isTracked(ACTOR), false);
    balance.set(CHAR, 400); // paid while offline (e.g. staff from the web panel)
    await sync.tick();
    assert.equal(state().inventory, 100, 'offline characters are not touched');
    await sync.onLogin(ACTOR, CHAR);
    assert.deepEqual(state(), { inventory: 400, balance: 400, synced: 400 });
  });
});

describe('economy-physical-sync: module off', () => {
  it('does nothing when the module is disabled', async () => {
    const off = createGoldSync({
      db: fakeDb(), mp: fakeMp(), transactions: fakeTransactions(),
      listActive: () => [ACTOR], getCharacter: () => ({ characterId: CHAR }), isEnabled: () => false,
      logger: { log() {}, warn() {}, error() {} }
    });
    balance.set(CHAR, 100);
    assert.equal(await off.onLogin(ACTOR, CHAR), null);
    await off.tick();
    assert.deepEqual(state(), { inventory: 0, balance: 100, synced: undefined });
  });
});
