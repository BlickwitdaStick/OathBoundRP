/**
 * core/economy-physical-sync.js
 *
 * **Anti-cheat, not balance synchronization.** `characters.gold` (via
 * `core/transaction-service.js`/`core/economy-service.js`) is the only source of
 * truth for the player's money and **never** existed as physical `Gold001` in
 * the Skyrim inventory — `addGold`/`removeGold` (`transaction-service.js`
 * lines 516-584) never call `_applyToClient`, unlike `giveItem`/
 * `removeItem`, which apply real items. Gold in this project is 100%
 * virtual, on purpose.
 *
 * ─── So why does this file exist ────────────────────────────────────────────
 *
 * The original brief asked for "physical synchronization: the server fixes the
 * inventory when it diverges from the DB". That assumes dual-represented gold
 * — exactly the model this project does **not** use, and making gold physical
 * would open the surface this task exists to close (draggable gold,
 * droppable, sellable to a vanilla NPC without going through the ledger). Confirmed with
 * the product owner before implementing.
 *
 * What remains useful is the inverse: if `Gold001` shows up in a
 * character's inventory, it cannot have come from any legitimate path in this
 * gamemode — it is evidence of external injection (cheat engine, save editor,
 * exploit from another mod). `reconcileOnLogin` checks for that once per login,
 * removes the physical item (never touches `characters.gold` — the real balance was never
 * wrong) and leaves a trail in `audit_logs` for staff to investigate.
 *
 * ─── Why only on login, not on a heartbeat ──────────────────────────────────
 *
 * A Papyrus call costs 13-35ms (`docs/technical/PAPYRUS_USAGE_POLICY.md`
 * line 142). Running this in a loop for every player would weigh on the same budget
 * that `docs/CONSTITUICAO.md` §A.5 already warns about for NPCs. Login is the moment of
 * highest value for the lowest cost: it is exactly when a character edited
 * offline (altered save, item injected while disconnected) enters the
 * world for the first time this session.
 */

'use strict';

const moduleRegistry = require('./module-registry');
const papyrus = require('./skymp-adapter/papyrus-catalog');
const { actorRef } = require('./papyrus');
const database = require('../database');

const MODULE_ID = 'economy-physical-sync';

/**
 * FormID of `Gold001` — a base item from Skyrim.esm. A universal vanilla constant
 * (not a save-specific cell/base FormDesc; it is the same in every
 * Skyrim world, it is literally the example `player.additem f 100` teaches in
 * any console tutorial for the game). A number, not a string — it does not trip the
 * guard in `scripts/check-write-guards.js` (which polices FormDesc in cell
 * fields, not numeric item FormIDs).
 */
const GOLD_BASE_ID = 0x0000000f;

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    mp: dependencies.mp !== undefined ? dependencies.mp : (typeof mp !== 'undefined' ? mp : undefined),
    logger: dependencies.logger || console
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

async function _auditAnomaly(deps, { actorId, characterId, count }) {
  try {
    await deps.db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'economy:physical_gold_anomaly',
        null,
        null,
        JSON.stringify({ characterId, actorId: actorId != null ? actorId.toString(16) : null, removedCount: count })
      ]
    );
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Failed to write audit_logs (anomaly not lost, just not recorded): ${err.message}`);
  }
}

/**
 * Checks and fixes physical `Gold001` in the inventory of a character who just
 * logged in. Never throws, never blocks login — same pattern as
 * `grantStartingGold` in `whitelist.js`.
 * @param {number} actorId
 * @param {number} characterId
 * @param {object} [dependencies]
 */
async function reconcileOnLogin(actorId, characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return;
  if (typeof deps.mp === 'undefined' || !deps.mp) return;

  if (!papyrus.isKnownPapyrusFunction('method', 'ObjectReference', 'GetItemCount')) {
    deps.logger.warn('[economy-physical-sync] ObjectReference.GetItemCount is not in papyrus-catalog.js — physical gold anti-cheat inactive.');
    return;
  }

  let count;
  try {
    count = deps.mp.callPapyrusFunction('method', 'ObjectReference', 'GetItemCount', actorRef(actorId), [GOLD_BASE_ID]);
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Failed to read GetItemCount for ${characterId}: ${err.message}`);
    return;
  }

  if (!Number.isFinite(count) || count <= 0) return;

  deps.logger.warn(
    `[economy-physical-sync] Anomalous physical gold detected: char=${characterId} actor=${actorId != null ? actorId.toString(16) : '?'} count=${count}. ` +
    'No legitimate path in this gamemode grants physical Gold001 — removing it and recording in audit_logs.'
  );

  try {
    if (papyrus.isKnownPapyrusFunction('method', 'ObjectReference', 'RemoveItem')) {
      deps.mp.callPapyrusFunction('method', 'ObjectReference', 'RemoveItem', actorRef(actorId), [GOLD_BASE_ID, count, true, null]);
    }
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Failed to remove physical Gold001 from ${characterId}: ${err.message}`);
  }

  await _auditAnomaly(deps, { actorId, characterId, count });
}

function healthCheck() {
  return true;
}

module.exports = {
  MODULE_ID,
  GOLD_BASE_ID,
  reconcileOnLogin,
  healthCheck
};
