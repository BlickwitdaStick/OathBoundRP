/**
 * inventory-service.js — projecting the inventory onto the client
 *
 * ⚠️ **This file is not the Inventory Framework.** Since 2026-08-13, the central
 * item-movement API is `core/inventory.js`, and its documentation
 * is `docs/framework/INVENTORY_FRAMEWORK.md`. What remains here is the other
 * half of the subject: taking what the DB knows to the player's screen, and the three
 * historical shortcuts (`giveItem`/`removeItem`/`hasItem`) that are still valid
 * for the **single owner** case.
 *
 * Which one to use:
 *
 *   - one owner changes (staff gives an item, a reward) → from here, or transaction-service
 *   - **two** owners (trade, chest, stall, craft)       → `core/inventory.transfer`
 *
 * ─── Known limit of the reconciliation ──────────────────────────────────────
 *
 * `syncInventoryToClient` is **one-way**: it hands the client what the
 * DB knows and never the reverse. It does not remove from the client what the
 * client has and the DB does not know, does not compare counts, and runs only once
 * (single caller: `whitelist.js`).
 *
 * Consequence: items picked up from the ground, vanilla NPC loot and quest rewards
 * exist only on the client, forever. That is the boundary named in
 * `docs/technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md` §3 — closing it requires reading
 * `mp.get(id,'inventory')` (still **[DOC]** in `types/mp.d.ts`, never
 * exercised) and deciding a divergence policy, which is a game decision.
 *
 * Inventory service with reconciliation to prevent duplicates.
 *
 * IMPORTANT: This service does NOT modify the DB directly.
 * Every item change uses core/transaction-service to guarantee
 * atomicity and traceability in the ledger.
 *
 * Reconciliation:
 * - On login, the server reads the DB snapshot (character_inventory)
 * - Compares it with what was delivered in this session (in-memory flag)
 * - Only calls AddItem for items not yet synced
 * - Divergences are logged for manual review
 */

const db = require('./database');
const transactionService = require('./core/transaction-service');
const { actorRef } = require('./core/papyrus');

// Cache of items already synced in this session: characterId → Set<baseId>
// Reset automatically on disconnect (cleanup via removeActiveCharacter)
const _syncedThisSession = new Map();

/**
 * Syncs the inventory from the database to the client.
 * Uses reconciliation to prevent duplicates on reconnects.
 *
 * @param {number} actorId
 * @param {number} characterId
 */
async function syncInventoryToClient(actorId, characterId) {
  try {
    const rows = await db.query(
      'SELECT base_id, count FROM character_inventory WHERE character_id = ?',
      [characterId]
    );

    // Initialize the synced set for this session
    if (!_syncedThisSession.has(characterId)) {
      _syncedThisSession.set(characterId, new Set());
    }
    const synced = _syncedThisSession.get(characterId);

    let syncedCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      if (synced.has(row.base_id)) {
        // Already delivered in this session — skip to prevent a duplicate
        skippedCount++;
        continue;
      }

      if (typeof mp !== 'undefined') {
        try {
          mp.callPapyrusFunction('method', 'ObjectReference', 'AddItem', actorRef(actorId), [row.base_id, row.count, true]);
          synced.add(row.base_id);
          syncedCount++;
        } catch (clientErr) {
          // Client failure: the DB is correct, the client may diverge
          // It will be resolved on the next sync or reconnect
          console.error(`[inventory] Warning: failed to sync item 0x${row.base_id.toString(16)} to actor ${actorId.toString(16)}:`, clientErr.message);
        }
      } else {
        // No mp runtime (test environment) — just mark as synced
        synced.add(row.base_id);
        syncedCount++;
      }
    }

    console.log(`[inventory] Sync for char ${characterId}: ${syncedCount} items delivered, ${skippedCount} already synced (total in DB: ${rows.length})`);
    
    if (skippedCount > 0) {
      console.log(`[inventory] Reconciliation: ${skippedCount} items skipped because they were already in the session (prevents duplicates)`);
    }

  } catch (err) {
    console.error(`[inventory] Error syncing inventory for char ${characterId}:`, err.message);
  }
}

/**
 * Clears the sync cache on disconnect.
 * @param {number} characterId
 */
function clearSyncCache(characterId) {
  _syncedThisSession.delete(characterId);
}

/**
 * Grants an item to the character (uses transaction-service).
 * Convenience wrapper for legacy code that calls inventory-service directly.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function giveItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.giveItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Removes an item from the character (uses transaction-service).
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function removeItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.removeItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Checks whether the character has enough of an item.
 * Uses the database as the source of truth.
 *
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} [minCount]
 * @returns {Promise<boolean>}
 */
async function hasItem(characterId, baseId, minCount = 1) {
  return transactionService.hasItem(characterId, baseId, minCount);
}

module.exports = {
  syncInventoryToClient,
  clearSyncCache,
  giveItem,
  removeItem,
  hasItem
};
