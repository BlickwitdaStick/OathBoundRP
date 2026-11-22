/**
 * core/crime-service.js
 *
 * Foundation of the Crime and Provenance System (Task 12). "Thief" is not a
 * profession in this project — it is an identity that emerges from the actions recorded
 * here. The technical pillar is the hybrid inventory: an ordinary item stays
 * fungible in `character_inventory` (stacked by `base_id`); a stolen item leaves
 * the stack at the moment of the theft and becomes its own row in `item_instances`, with a
 * UUID and ownership history — see `migration-v21-crime-provenance.sql`.
 *
 * ─── Scope of the foundation (Task 12, 2026-08-21) ──────────────────────────
 *
 * Migration + rule engine (hot item, anti-combat-log, restitution) +
 * `audit_logs.is_crime`.
 *
 * ─── Scope of Task 13 (Criminal Interactions and Guard Authority) ───────────
 *
 * `crime.surrender` (SELF) and `crime.rob` (PLAYER) in the Interaction Framework —
 * robbery is only allowed against a target who surrendered (`character-state.SURRENDERED`,
 * set by `crime.surrender`) or is incapacitated (`RESTRAINED`/`DOWNED`, which already
 * exist). `getStolenInstancesHeldBy` resolves `original_owner_id` to a
 * character name — it is what `governance-service.showInventorySnapshot`
 * calls so the Institutional Search says "this ring belongs to
 * Balgruuf", never "he is a thief" (no oracle). `markItemConfiscated`
 * implements the Evidence Logic: a confiscated item loses `hot` but
 * stays `stolen` until it is restituted — it never becomes `clean` through confiscation
 * alone.
 *
 * `governance-service.js` already had `requestSearch`/`approveSearch`/
 * `confiscateItem` and the `guard` post with `GUARD_SEARCH`/`GUARD_CONFISCATE` —
 * the authorization "only approved posts trigger a search" already existed before
 * this task; what was missing was the search **knowing about provenance**.
 *
 * ─── Surrender animation: a known gap ───────────────────────────────────────
 *
 * There is no `animation-service.js` in this project. `crime.surrender` reuses the
 * same Papyrus primitive `admin-service.playAnimation` already uses
 * (`Actor.PlayIdle`), with an idle name that is an **assumption, not validated in
 * game** — same caveat as `core/interaction-targets.js` about
 * `locationalData`. The state change (`SURRENDERED`) is what
 * `crime.rob` actually checks; the animation is only the visual signal, best-effort,
 * and it never blocks the surrender if it fails.
 *
 * ─── Why only stolen items become instances (not "high value") ─────────────
 *
 * Product owner's decision: instancing by value would require a reliable price
 * table per `base_id`, which this project does not have today. Lazy
 * instancing — only at the moment of the theft — keeps every never-stolen item 100% in the
 * common stack, at zero cost.
 *
 * ─── Atomicity ───────────────────────────────────────────────────────────
 *
 * `markItemStolen` and restitution use the `tx.*` primitives from
 * `transaction-service.js` (same contract `depot-service.js` already follows):
 * a single SQL transaction moves physical ownership AND marks provenance. Never
 * two separate transactions for the same theft operation.
 *
 * ─── Technical Restitution ──────────────────────────────────────────────────
 *
 * It reuses `core/depot-service.js` (product owner's decision, 2026-08-21): the
 * item goes back to the original owner's depot in the hold where the theft happened
 * (`item_instances.last_hold_id`), not to a new return mechanism.
 * If the `depot` module is off, the restitution stays pending and is
 * retried on the next sweep — it never fails the `crime` boot because
 * of that (optional dependency, not a required one).
 */

'use strict';

const crypto = require('crypto');
const database = require('../database');
const moduleRegistry = require('./module-registry');
const serverOptions = require('./server-options');
const transactionService = require('./transaction-service');
const depotService = require('./depot-service');
const commands = require('../commands');
const characterState = require('./character-state');
const interactionRegistry = require('./interaction-registry');
const { actorRef } = require('./papyrus');

const MODULE_ID = 'crime';

/** States of `item_instances.status`. */
const STATUS = Object.freeze({ HOT: 'hot', STOLEN: 'stolen', CLEAN: 'clean' });

/**
 * Range of `crime.rob` — robbery is close contact, not a ranged
 * action. A plain constant (geometry, not balancing), same
 * criterion as `DEPOT_INTERACT_RANGE` in `core/depot-service.js`.
 */
const ROB_RANGE = 150;

/**
 * [DOC] Idle name played in `crime.surrender`, via the same primitive
 * `admin-service.playAnimation` uses (`Actor.PlayIdle`). Assumed from
 * common conventions for vanilla "hands up/surrender" idles — **not
 * validated in game in this project**. It never blocks the surrender if the call
 * fails (see `_applySurrenderAnimation`).
 */
const SURRENDER_IDLE = 'IdleHandsForward';

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    serverOptions: dependencies.serverOptions || serverOptions,
    tx: dependencies.tx || transactionService.tx,
    depot: dependencies.depot || depotService,
    commands: dependencies.commands || commands,
    characterState: dependencies.characterState || characterState,
    logger: dependencies.logger || console
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function _appendProvenance(existingJson, entry) {
  let list = [];
  if (existingJson) {
    // mysql2 already returns parsed JSON when the column is JSON; a string is the
    // test case with a plain DB stub.
    list = typeof existingJson === 'string' ? JSON.parse(existingJson) : existingJson;
  }
  return [...list, entry];
}

async function _resolveAccountId(conn, characterId) {
  if (!_isPositiveInt(characterId)) return null;
  const [rows] = await conn.query('SELECT account_id FROM characters WHERE id = ?', [characterId]);
  return rows.length > 0 ? rows[0].account_id : null;
}

/**
 * Writes to `audit_logs` with `is_crime=1`. Every transfer of an
 * instanced item goes through here — objective 5 of the brief. It runs inside the SAME
 * `conn` transaction as the ownership move, never after the commit.
 */
async function _recordCrimeAudit(conn, { action, actorCharacterId, targetCharacterId, itemInstanceId, details }) {
  const actorAccountId = await _resolveAccountId(conn, actorCharacterId);
  const targetAccountId = await _resolveAccountId(conn, targetCharacterId);
  await conn.query(
    `INSERT INTO audit_logs (action, actor_account_id, target_account_id, details, is_crime, item_instance_id)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [action, actorAccountId, targetAccountId, details ? JSON.stringify(details) : null, itemInstanceId || null]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Roubo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks 1 unit of `baseId` as stolen: transfers physical ownership from
 * `victimCharacterId` to `thiefCharacterId` and creates (or updates, in the case of a
 * re-theft) the `item_instances` row — all in a single SQL transaction.
 *
 * @param {object} opts
 * @param {number} [opts.victimActorId] the victim's SkyMP actor, to apply on the client
 * @param {number} opts.victimCharacterId
 * @param {number} [opts.thiefActorId] the thief's SkyMP actor, to apply on the client
 * @param {number} opts.thiefCharacterId
 * @param {number} opts.baseId native FormID of the stolen item
 * @param {string} opts.holdId Hold where the theft happened (used by Technical Restitution)
 * @param {string} [opts.reason] reason/context of the theft (default: 'crime_theft')
 * @param {object} [dependencies]
 */
async function markItemStolen(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const {
    victimActorId, victimCharacterId,
    thiefActorId, thiefCharacterId,
    baseId, holdId, reason = 'crime_theft'
  } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(victimCharacterId)) return { ok: false, code: 'invalid_victim' };
  if (!_isPositiveInt(thiefCharacterId)) return { ok: false, code: 'invalid_thief' };
  if (victimCharacterId === thiefCharacterId) return { ok: false, code: 'self_theft' };
  if (!_isPositiveInt(baseId)) return { ok: false, code: 'invalid_item' };
  if (typeof holdId !== 'string' || !holdId) return { ok: false, code: 'invalid_hold' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    // The same primitive every other item transfer in this project
    // uses (`depot-service.depositItem`, trade's `transfer`) — no second
    // implementation of "how to touch items". `applyStackDelta` already refuses (via
    // throw, caught below) if the victim does not really have the item.
    await deps.tx.applyStackDelta(conn, 'character_inventory', victimCharacterId, baseId, -1);
    await deps.tx.applyStackDelta(conn, 'character_inventory', thiefCharacterId, baseId, 1);
    await deps.tx.recordInventoryLedger(conn, { characterId: victimCharacterId, baseId, delta: -1, reason, module: MODULE_ID });
    await deps.tx.recordInventoryLedger(conn, { characterId: thiefCharacterId, baseId, delta: 1, reason, module: MODULE_ID });

    // Re-theft: the item was already a tracked instance (stolen from another
    // thief). Updates the SAME row — `original_owner_id` never changes after
    // the first time the item enters `item_instances`, otherwise
    // provenance loses the original legitimate owner.
    const [existing] = await conn.query(
      `SELECT id, provenance_data FROM item_instances
        WHERE base_id = ? AND current_owner_id = ? AND status IN ('hot', 'stolen') FOR UPDATE`,
      [baseId, victimCharacterId]
    );

    let instanceId;
    const now = new Date();
    if (existing.length > 0) {
      instanceId = existing[0].id;
      const provenance = _appendProvenance(existing[0].provenance_data, { ownerId: thiefCharacterId, at: now.toISOString(), reason });
      await conn.query(
        `UPDATE item_instances
            SET current_owner_id = ?, status = 'hot', stolen_at = NOW(), last_hold_id = ?, provenance_data = ?
          WHERE id = ?`,
        [thiefCharacterId, holdId, JSON.stringify(provenance), instanceId]
      );
    } else {
      instanceId = uuid();
      let provenance = _appendProvenance(null, { ownerId: victimCharacterId, at: now.toISOString(), reason: 'original_owner' });
      provenance = _appendProvenance(provenance, { ownerId: thiefCharacterId, at: now.toISOString(), reason });
      await conn.query(
        `INSERT INTO item_instances
          (id, base_id, original_owner_id, current_owner_id, status, stolen_at, last_hold_id, provenance_data)
         VALUES (?, ?, ?, ?, 'hot', NOW(), ?, ?)`,
        [instanceId, baseId, victimCharacterId, thiefCharacterId, holdId, JSON.stringify(provenance)]
      );
    }

    await _recordCrimeAudit(conn, {
      action: 'crime.item_theft',
      actorCharacterId: thiefCharacterId,
      targetCharacterId: victimCharacterId,
      itemInstanceId: instanceId,
      details: { baseId, holdId, reason }
    });

    await conn.commit();

    deps.tx.applyToClient(victimActorId, baseId, -1);
    deps.tx.applyToClient(thiefActorId, baseId, 1);

    deps.logger.log(`[crime] theft: item=0x${baseId.toString(16)} victim=${victimCharacterId} thief=${thiefCharacterId} instance=${instanceId}`);
    return { ok: true, data: { instanceId } };
  } catch (err) {
    await conn.rollback();
    deps.logger.error('[crime] markItemStolen failed:', err.message);
    return { ok: false, code: 'error', error: err.message };
  } finally {
    conn.release();
  }
}

/** Reads an item's active instance, if there is one. */
async function getInstance(instanceId, dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query('SELECT * FROM item_instances WHERE id = ?', [instanceId]);
  return rows.length > 0 ? rows[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance for the Institutional Search (Task 13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Items `characterId` is carrying that have dirty provenance (`hot` or
 * `stolen`), with the original owner's name already resolved — never a raw
 * `characterId`. It is what makes the search UI say "This ring belongs to
 * Balgruuf the Greater!" instead of "he is a thief": the verdict belongs to the
 * player reading the name, not to the server labeling anyone.
 *
 * @param {number} characterId
 * @param {object} [dependencies]
 * @returns {Promise<Array<{instanceId:string, baseId:number, status:string, originalOwnerId:number, originalOwnerName:string}>>}
 */
async function getStolenInstancesHeldBy(characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(characterId)) return [];

  const rows = await deps.db.query(
    `SELECT ii.id, ii.base_id, ii.status, ii.original_owner_id, c.first_name, c.last_name
       FROM item_instances ii
       JOIN characters c ON c.id = ii.original_owner_id
      WHERE ii.current_owner_id = ? AND ii.status IN ('hot', 'stolen')
      ORDER BY ii.base_id`,
    [characterId]
  );

  return rows.map((row) => ({
    instanceId: row.id,
    baseId: Number(row.base_id),
    status: row.status,
    originalOwnerId: row.original_owner_id,
    originalOwnerName: `${row.first_name} ${row.last_name}`.trim()
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence: confiscation (Task 13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks 1 instance as confiscated: it loses `hot` (stops counting as a "recent
 * theft" for bounty/alert purposes) but stays `stolen` — it never becomes
 * `clean` through confiscation alone. Only Technical Restitution (`sweep`/
 * `_restitute`, back to the original owner) or an equivalent return can
 * clear the provenance.
 *
 * It moves no items: `governance-service.confiscateItem` already called
 * `inventory.removeItem` before this (that is what physically takes the item from the
 * character); here it is only the provenance metadata update. It does not
 * write to `confiscations` — that table exists since
 * `migration-v3-governance.sql` and `governance-service.js` writes to it
 * directly; `migration-v22-crime-interactions.sql` only ADDS the
 * `item_instance_id` column to it, to link the evidence record back to the
 * tracked instance.
 *
 * @param {object} opts
 * @param {number} opts.characterId who the item was confiscated from
 * @param {number} opts.baseId
 * @param {object} [dependencies]
 */
async function markItemConfiscated(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, baseId } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId) || !_isPositiveInt(baseId)) return { ok: false, code: 'invalid_input' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, status FROM item_instances
        WHERE current_owner_id = ? AND base_id = ? AND status IN ('hot', 'stolen') FOR UPDATE`,
      [characterId, baseId]
    );
    if (rows.length === 0) {
      await conn.rollback();
      // Not an error: most confiscated items were never stolen, and
      // ordinary confiscation (`governance-service.confiscateItem`) keeps
      // working without any instance to update.
      return { ok: false, code: 'no_instance' };
    }

    const instance = rows[0];
    if (instance.status === 'hot') {
      await conn.query(`UPDATE item_instances SET status = 'stolen' WHERE id = ?`, [instance.id]);
    }

    await _recordCrimeAudit(conn, {
      action: 'crime.item_confiscated',
      actorCharacterId: null,
      targetCharacterId: characterId,
      itemInstanceId: instance.id,
      details: { baseId }
    });

    await conn.commit();
    return { ok: true, data: { instanceId: instance.id } };
  } catch (err) {
    await conn.rollback();
    deps.logger.error('[crime] markItemConfiscated failed:', err.message);
    return { ok: false, code: 'error', error: err.message };
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-Combat-Log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscriber of `commands.onCharacterRemoved`. Creates a `session_crime_alert`
 * for each 'hot' item the character was carrying when they disconnected — the
 * sweep (`sweep`) later decides whether they came back in time or the item is
 * restituted.
 *
 * @param {number} actorId
 * @param {{characterId: number}} character the exact shape `commands.js`
 *   passes to `onCharacterRemoved` subscribers (the field is `characterId`, not `id`)
 * @param {object} [dependencies]
 */
async function onCharacterDisconnected(actorId, character, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return;

  const characterId = character && character.characterId;
  if (!_isPositiveInt(characterId)) return;

  const hotItems = await deps.db.query(
    `SELECT id FROM item_instances WHERE current_owner_id = ? AND status = 'hot'`,
    [characterId]
  );
  for (const row of hotItems) {
    await deps.db.query(
      'INSERT INTO session_crime_alerts (character_id, item_instance_id) VALUES (?, ?)',
      [characterId, row.id]
    );
  }
  if (hotItems.length > 0) {
    deps.logger.log(`[crime] ${hotItems.length} combat-log alert(s) created when character ${characterId} disconnected`);
  }
}

/**
 * Returns 1 unit of `alert.base_id` to the original owner via `depot-service`,
 * inside a single transaction together with the `item_instances` update.
 * @param {{character_id:number, base_id:number, item_instance_id:string, original_owner_id:number}} alert
 * @param {object} deps already resolved by `_deps`
 */
async function _restitute(alert, deps) {
  if (!deps.moduleRegistry.isEnabled('depot')) {
    return { ok: false, code: 'depot_disabled' };
  }

  const rows = await deps.db.query('SELECT last_hold_id FROM item_instances WHERE id = ?', [alert.item_instance_id]);
  const holdId = rows.length > 0 ? rows[0].last_hold_id : null;
  if (!holdId) return { ok: false, code: 'missing_hold' };

  // Makes sure the original owner's depot exists (opens its own short
  // transaction, same pattern `depot-service.depositItem` already uses
  // internally) before locking the row in the main transaction below.
  const depot = await deps.depot.getOrCreateDepot(alert.original_owner_id, holdId, deps);

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [depotRows] = await conn.query('SELECT id FROM character_depots WHERE id = ? FOR UPDATE', [depot.id]);
    if (depotRows.length === 0) {
      await conn.rollback();
      return { ok: false, code: 'depot_not_found' };
    }

    await deps.tx.applyStackDelta(conn, 'character_inventory', alert.character_id, alert.base_id, -1);
    await deps.tx.recordInventoryLedger(conn, { characterId: alert.character_id, baseId: alert.base_id, delta: -1, reason: 'crime_restitution', module: MODULE_ID });
    await deps.tx.applyStackDelta(conn, 'depot_inventory', depot.id, alert.base_id, 1);

    await conn.query(
      `UPDATE item_instances SET current_owner_id = ?, status = 'clean' WHERE id = ?`,
      [alert.original_owner_id, alert.item_instance_id]
    );

    await _recordCrimeAudit(conn, {
      action: 'crime.item_restitution',
      actorCharacterId: null,
      targetCharacterId: alert.original_owner_id,
      itemInstanceId: alert.item_instance_id,
      details: { baseId: alert.base_id, holdId, thiefCharacterId: alert.character_id }
    });

    await conn.commit();
    return { ok: true };
  } catch (err) {
    await conn.rollback();
    return { ok: false, code: 'error', error: err.message };
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * (1) Cools 'hot' items down to 'stolen' after `crime.hotItemWindowMinutes`.
 * (2) Resolves combat-log alerts: if the character is already online again,
 *     resolves without restitution; if the grace period (`crime.combatLogGraceMinutes`)
 *     has passed and they are still offline, restitutes via `depot-service`.
 *
 * Called by its own `setInterval` (see `initSweepTimer`), never from
 * a game event — same idiom as `market-stalls-service.expireStalls`.
 */
async function sweep(dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return { cooled: 0, restituted: 0, pending: 0 };

  const hotWindowMinutes = deps.serverOptions.get('crime.hotItemWindowMinutes');
  const graceMinutes = deps.serverOptions.get('crime.combatLogGraceMinutes');

  const cooledResult = await deps.db.query(
    `UPDATE item_instances SET status = 'stolen'
      WHERE status = 'hot' AND stolen_at <= NOW() - INTERVAL ? MINUTE`,
    [hotWindowMinutes]
  );
  const cooled = cooledResult.affectedRows || 0;

  const pendingAlerts = await deps.db.query(
    `SELECT sca.id AS alert_id, sca.character_id, sca.item_instance_id,
            ii.base_id, ii.original_owner_id
       FROM session_crime_alerts sca
       JOIN item_instances ii ON ii.id = sca.item_instance_id
      WHERE sca.resolved = 0 AND sca.disconnected_at <= NOW() - INTERVAL ? MINUTE`,
    [graceMinutes]
  );

  let restituted = 0;
  for (const alert of pendingAlerts) {
    // The player came back before this sweep ran: resolve without restitution.
    if (deps.commands.getActiveActorByCharacterId(alert.character_id)) {
      await deps.db.query('UPDATE session_crime_alerts SET resolved = 1, resolved_at = NOW() WHERE id = ?', [alert.alert_id]);
      continue;
    }

    const result = await _restitute(alert, deps);
    if (result.ok) {
      restituted += 1;
      await deps.db.query('UPDATE session_crime_alerts SET resolved = 1, resolved_at = NOW() WHERE id = ?', [alert.alert_id]);
    } else {
      // Stays pending (`resolved=0`) — retried on the next sweep.
      // `depot_disabled` is the expected case if nobody turned on ENABLE_DEPOT_SERVICE.
      deps.logger.error(`[crime] restitution postponed for alert ${alert.alert_id}: ${result.code}`);
    }
  }

  return { cooled, restituted, pending: pendingAlerts.length - restituted };
}

let _sweepTimer = null;

/** Starts the periodic sweep. Called from the module's `initialize()`. */
function initSweepTimer(dependencies = {}) {
  const deps = _deps(dependencies);
  const intervalSeconds = deps.serverOptions.get('crime.sweepIntervalSeconds');
  _sweepTimer = setInterval(async () => {
    try {
      const result = await sweep(dependencies);
      if (result.cooled > 0 || result.restituted > 0) {
        deps.logger.log(`[crime] sweep: ${result.cooled} cooled, ${result.restituted} restituted, ${result.pending} pending`);
      }
    } catch (err) {
      deps.logger.error('[crime] sweep failed:', err.message);
    }
  }, intervalSeconds * 1000);
}

/** Stops the periodic sweep. Called from the module's `shutdown()`. */
function stopSweepTimer() {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction Framework — crime.surrender / crime.rob (Tarefa 13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A target can be robbed if they surrendered (voluntarily, `crime.surrender`) or are
 * incapacitated (`RESTRAINED` — cuffed by the guard, or `DOWNED` — downed in
 * combat). Neither is set by this file; `crime.rob` only reads them.
 */
function _isRobbable(characterId, deps) {
  return deps.characterState.is(characterId, [
    deps.characterState.STATES.SURRENDERED,
    deps.characterState.STATES.RESTRAINED,
    deps.characterState.STATES.DOWNED
  ]);
}

/** Best-effort: never throws, never blocks the surrender. See the [DOC] note in the header. */
function _applySurrenderAnimation(actorId) {
  if (typeof mp === 'undefined') return;
  try {
    mp.callPapyrusFunction('method', 'Actor', 'PlayIdle', actorRef(actorId), [SURRENDER_IDLE]);
  } catch (err) {
    console.error('[crime] surrender animation failed (ignored):', err.message);
  }
}

/**
 * Registers `crime.surrender` (SELF) and `crime.rob` (PLAYER) in the Interaction
 * Framework. Called from the module's `initialize()` — it needs the interaction
 * framework already up (`dependencies: ['interaction']` in `phase0-basic.js`,
 * same pattern as `depot-service.registerInteractions`).
 *
 * The `TARGET_TYPES.SELF` resolver already exists (registered by
 * `core/character-dashboard-bridge.js`, Task 11) — this file does not
 * register a second one, it only declares one more interaction against that type.
 */
function registerInteractions(dependencies = {}) {
  const deps = _deps(dependencies);
  interactionRegistry.unregisterModule(MODULE_ID);

  interactionRegistry.register({
    id: 'crime.surrender',
    module: MODULE_ID,
    target: interactionRegistry.TARGET_TYPES.SELF,
    section: 'crime',
    label: 'Surrender',
    order: 10,
    audit: interactionRegistry.AUDIT_LEVELS.GAMEPLAY,
    execute: async (ctx) => {
      deps.characterState.set(ctx.characterId, deps.characterState.STATES.SURRENDERED, { at: Date.now() });
      _applySurrenderAnimation(ctx.actorId);
      deps.commands.broadcastProximityMessage(ctx.actorId, '* Levanta as maos e se rende.', 600);
      return { message: 'You surrendered. Anyone nearby can now search or rob you.' };
    }
  });

  interactionRegistry.register({
    id: 'crime.rob',
    module: MODULE_ID,
    target: interactionRegistry.TARGET_TYPES.PLAYER,
    section: 'crime',
    label: 'Rob',
    order: 20,
    distance: ROB_RANGE,
    audit: interactionRegistry.AUDIT_LEVELS.SECURITY,
    schema: {
      baseId: { type: 'formid', label: 'Item', required: true, placeholder: '0x0000000F' },
      // There is no "hold from the player's position" resolver in this project (see
      // core/interaction-targets.js, header, about locationalData). The
      // client reports it; it is only used by Technical Restitution to know where to
      // return things later — it never affects the theft itself.
      holdId: { type: 'string', label: 'Current region', max: 64, default: 'unknown' }
    },
    // `canSee`/`canExecute` are the same verdict: if the target cannot be robbed, the
    // action does not even show up in the menu. `execute` checks again (redundant on
    // purpose, same criterion as the rest of the pipeline).
    canSee: async (ctx) => _isRobbable(ctx.target.characterId, deps),
    canExecute: async (ctx) => {
      const robbable = _isRobbable(ctx.target.characterId, deps);
      return { allowed: robbable, reason: robbable ? '' : 'The target must have surrendered or be incapacitated.' };
    },
    execute: async (ctx) => {
      if (!_isRobbable(ctx.target.characterId, deps)) {
        throw new Error('The target has not surrendered and is not incapacitated.');
      }
      const result = await markItemStolen({
        victimActorId: ctx.target.actorId,
        victimCharacterId: ctx.target.characterId,
        thiefActorId: ctx.actorId,
        thiefCharacterId: ctx.characterId,
        baseId: ctx.data.baseId,
        holdId: ctx.data.holdId || 'unknown'
      }, dependencies);
      if (!result.ok) throw new Error('Could not steal this item.');
      return { message: 'Item roubado.', data: result.data };
    }
  });
}

module.exports = {
  MODULE_ID,
  STATUS,
  ROB_RANGE,
  markItemStolen,
  getInstance,
  getStolenInstancesHeldBy,
  markItemConfiscated,
  onCharacterDisconnected,
  sweep,
  initSweepTimer,
  stopSweepTimer,
  registerInteractions,

  // Exposed only for tests.
  _restitute,
  _isRobbable
};
