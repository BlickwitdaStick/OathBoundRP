/**
 * core/economy-physical-sync.js
 *
 * Keeps the gold in a character's inventory (Gold001) and the server balance
 * (`characters.gold`) equal: they are the same money.
 *
 * - Gold looted from a chest or a body, picked up, or dropped in game changes
 *   the balance.
 * - Server payments (stalls, trade, depot, salaries, staff "set gold") go
 *   through core/transaction-service.js as before and only touch the balance;
 *   this module then adds or removes that much real gold in the inventory.
 *
 * Until 2026-11-20 gold was virtual only, and this module removed any Gold001
 * it found as a cheat. The owner asked for gold to be tied to the inventory.
 *
 * ─── How the two sides are merged ───────────────────────────────────────────
 *
 * `characters.gold_synced` (migration-v34) is the amount both sides last
 * agreed on. Every TICK_MS, for each online character:
 *
 *     inventory change = inventory - synced     (looting, dropping…)
 *     balance change   = balance - synced       (server payments)
 *     new amount       = synced + both changes  (never below 0)
 *
 * The balance gets the inventory's change through transaction-service (with a
 * ledger row, reason "inventory_gold"), the inventory gets the balance's change
 * through AddItem/RemoveItem, and `gold_synced` becomes the new amount. Changes
 * on both sides in the same tick are added together, never overwritten, and a
 * payment that commits while a sync runs is picked up by the next one.
 *
 * Reading costs one GetItemCount on the server's own copy of the inventory
 * (SkyMP keeps it server-side; no round trip to the game client) and one
 * SELECT, every few seconds per online character.
 *
 * NULL `gold_synced` (never synced) counts as 0: the first sync adds gold
 * already in the inventory to the balance and puts the balance in the
 * inventory. Gold that was looted while gold was virtual is kept that way.
 */

'use strict';

const moduleRegistry = require('./module-registry');
const { actorRef, baseRef } = require('./papyrus');

const MODULE_ID = 'economy-physical-sync';

/** FormID of Gold001 in Skyrim.esm. */
const GOLD_BASE_ID = 0x0000000f;
const TICK_MS = 5000;
const REASON = 'inventory_gold';

/**
 * @param {object} deps
 * @param {object} deps.db                  - query(sql, params) → rows
 * @param {object} deps.mp                  - callPapyrusFunction
 * @param {object} deps.transactions        - transaction-service (addGold/removeGold/getGold)
 * @param {() => number[]} deps.listActive  - online actor ids
 * @param {(actorId:number) => {characterId:number}|null} deps.getCharacter
 * @param {() => boolean} [deps.isEnabled]
 */
function createGoldSync({ db, mp, transactions, listActive, getCharacter, isEnabled = () => true, logger = console }) {
  /** actorId → { characterId, synced } */
  const tracked = new Map();
  const running = new Set();
  let timer = null;

  function inventoryGold(actorId) {
    const n = mp.callPapyrusFunction('method', 'ObjectReference', 'GetItemCount', actorRef(actorId), [baseRef(GOLD_BASE_ID)]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`GetItemCount returned ${JSON.stringify(n)}`);
    return Math.floor(n);
  }

  function changeInventory(actorId, delta) {
    if (delta > 0) {
      mp.callPapyrusFunction('method', 'ObjectReference', 'AddItem', actorRef(actorId), [baseRef(GOLD_BASE_ID), delta, true]);
    } else {
      mp.callPapyrusFunction('method', 'ObjectReference', 'RemoveItem', actorRef(actorId), [baseRef(GOLD_BASE_ID), -delta, true, null]);
    }
  }

  async function saveSynced(characterId, amount) {
    await db.query('UPDATE characters SET gold_synced = ? WHERE id = ?', [amount, characterId]);
  }

  async function changeBalance(characterId, delta) {
    if (delta === 0) return true;
    const opts = { characterId, amount: Math.abs(delta), reason: REASON, module: MODULE_ID };
    return delta > 0 ? transactions.addGold(opts) : transactions.removeGold(opts);
  }

  /**
   * One merge for one online character.
   * @returns {Promise<{inventory:number, balance:number, amount:number}|null>} null when skipped
   */
  async function syncOnce(actorId) {
    const t = tracked.get(actorId);
    if (!t || running.has(actorId)) return null;
    running.add(actorId);
    try {
      const inventory = inventoryGold(actorId);
      const balance = Number(await transactions.getGold(t.characterId)) || 0;
      if (inventory === t.synced && balance === t.synced) return { inventory, balance, amount: t.synced };

      let amount = inventory + balance - t.synced;
      if (amount < 0) {
        logger.warn(`[gold] char=${t.characterId}: spent ${-amount} more than it had (inventory ${inventory}, balance ${balance}, last agreed ${t.synced}); set to 0.`);
        amount = 0;
      }

      // Balance first: it is the atomic side. If it fails (a payment changed
      // it meanwhile), nothing else changes and the next tick tries again.
      if (!(await changeBalance(t.characterId, amount - balance))) return null;

      let agreed = amount;
      if (amount !== inventory) {
        try {
          changeInventory(actorId, amount - inventory);
        } catch (err) {
          // The balance is right; the inventory is not. Agreeing on what the
          // inventory holds makes the next tick try the same change again,
          // instead of reading the missing gold as spent.
          logger.error(`[gold] char=${t.characterId}: could not change inventory gold by ${amount - inventory}: ${err.message}`);
          agreed = inventory;
        }
      }
      t.synced = agreed;
      await saveSynced(t.characterId, agreed);
      if (agreed === amount) {
        logger.log(`[gold] char=${t.characterId}: ${amount} gold (inventory ${inventory}→${amount}, balance ${balance}→${amount})`);
      }
      return { inventory, balance, amount };
    } catch (err) {
      logger.error(`[gold] sync failed for actor ${actorId.toString(16)}: ${err.message}`);
      return null;
    } finally {
      running.delete(actorId);
    }
  }

  return {
    /** Starts tracking a character that just logged in, and syncs it right away. */
    async onLogin(actorId, characterId) {
      if (!isEnabled()) return null;
      const rows = await db.query('SELECT gold_synced FROM characters WHERE id = ?', [characterId]);
      const raw = rows.length ? rows[0].gold_synced : null;
      tracked.set(actorId, { characterId, synced: raw == null ? 0 : Number(raw) });
      return syncOnce(actorId);
    },

    /** Stops tracking. Nothing is read: `gold_synced` carries the state to the next login. */
    onDisconnect(actorId) {
      tracked.delete(actorId);
    },

    async tick() {
      if (!isEnabled()) return;
      for (const actorId of listActive()) {
        const ch = getCharacter(actorId);
        const t = tracked.get(actorId);
        if (!ch || !t || t.characterId !== ch.characterId) continue;
        await syncOnce(actorId);
      }
    },

    syncOnce,
    isTracked: (actorId) => tracked.has(actorId),

    start(ms = TICK_MS) {
      if (timer) return;
      timer = setInterval(() => { this.tick().catch((err) => logger.error('[gold] tick failed:', err.message)); }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

let _instance = null;

/** Shared instance for the running server (lazy: needs `mp` and the db). */
function getInstance() {
  if (!_instance) {
    const commands = require('../commands');
    _instance = createGoldSync({
      db: require('../database'),
      mp: { callPapyrusFunction: (...a) => mp.callPapyrusFunction(...a) },
      transactions: require('./transaction-service'),
      listActive: () => commands.listActiveActorIds(),
      getCharacter: (id) => commands.getActiveCharacterData(id),
      isEnabled: () => moduleRegistry.isEnabled(MODULE_ID)
    });
  }
  return _instance;
}

/** Login hook (whitelist.js). Never throws, never blocks login. */
async function reconcileOnLogin(actorId, characterId) {
  if (typeof mp === 'undefined') return null;
  return getInstance().onLogin(actorId, characterId);
}

function healthCheck() {
  return true;
}

module.exports = {
  MODULE_ID,
  GOLD_BASE_ID,
  TICK_MS,
  createGoldSync,
  getInstance,
  reconcileOnLogin,
  healthCheck
};
