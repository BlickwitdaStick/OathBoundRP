/**
 * core/depot-service.js
 *
 * Regional item storage. One depot per (character, hold) —
 * items stored in Whiterun do not show up in Solitude, because they are different
 * ROWS in `character_depots`, not a filter over a shared row. See
 * `docs/technical/DEPOT_SERVICE_AUDIT.md` for the 15 points of §15.
 *
 * ─── What this file explicitly does NOT do ──────────────────────────────────
 *
 * No gold. `characters.gold` is already global by nature (there is no "gold
 * in hand" vs "gold in the bank" in this project — see `core/economy-service.js`);
 * this file only DISPLAYS the existing balance (`getGoldBalance`), it never creates a
 * second reserve. Decision made with the product owner before implementing.
 *
 * No combat check. The brief asked for "cannot be used in combat", but
 * there is no live combat signal in this project: `core/hit-events.js` is
 * single-subscriber (already taken by `death-service.js`) and only reports AFTER
 * the episode closes (10s of silence) — it does not work as a real-time gate
 * without touching another system's shared infrastructure. Postponed, and it is a known gap,
 * not a forgotten one — see `DEPOT_SERVICE_AUDIT.md`.
 *
 * ─── Distance and target: the first real consumer of TARGET_TYPES.OBJECT ────
 *
 * `core/interaction-targets.js` already resolves any `MpObjectReference` in the
 * world (it was born for the Miner). Distance is enforced automatically
 * by the Interaction Framework via `entry.distance` + `target.assertRange()`
 * (`core/interaction-service.js`) — no manual check here. The same
 * caveat `interaction-targets.js` already records applies to this file:
 * `locationalData` against an ordinary object is **assumed from the
 * official SkyMP documentation, not validated in game**.
 *
 * ─── Deposit/withdraw atomicity ─────────────────────────────────────────────
 *
 * A single transaction, two calls to `transactionService.tx.applyStackDelta`
 * (one for `character_inventory`, one for `depot_inventory`) — same pattern
 * as `economy-service.transferInTransaction`. A failure in either one rolls back
 * both. `depot_inventory` was added to `STACK_TABLES` in
 * `transaction-service.js` for this to work; no new transaction logic
 * was written — it is reuse, not reimplementation.
 */

'use strict';

const database = require('../database');
const moduleRegistry = require('./module-registry');
const serverOptions = require('./server-options');
const transactionService = require('./transaction-service');
const economyService = require('./economy-service');
const interactionRegistry = require('./interaction-registry');
const physicalAnchorRegistry = require('./physical-anchor-registry');
const inventory = require('./inventory');
const inventoryOwner = require('./inventory-owner');

const MODULE_ID = 'depot';

/**
 * "3 meters" (brief) converted to Skyrim units. There is no
 * meter→unit conversion anywhere else in the project — every existing radius
 * (`proximity-ranges.js`, `RESCUE_RANGE`, `STALL_INTERACTION_RANGE`)
 * is already born in Skyrim units. I use the widely documented modding constant
 * (~70.5 units per meter): 3 * 70.5 ≈ 211. A plain constant
 * (not a server-option) by the same criterion as `RESCUE_RANGE` in
 * `death-service.js` — it is the chest's physical geometry, not gameplay
 * balancing.
 */
const DEPOT_INTERACT_RANGE = 211;

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    serverOptions: dependencies.serverOptions || serverOptions,
    tx: dependencies.tx || transactionService.tx,
    economy: dependencies.economy || economyService,
    // `inventory.list` is the same adapter `character_inventory` uses
    // everywhere else in the project (trade, shop) — no new read.
    inventory: dependencies.inventory || inventory,
    logger: dependencies.logger || console,
    // No-op by default (e.g. direct calls in tests) — whoever actually wires the CEF
    // is `phase0-basic.js`, via `registerInteractions({ sendModal })`.
    sendModal: dependencies.sendModal || (() => {})
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Depot (the row in character_depots, not the items inside it)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads and locks the depot row inside the caller's transaction. Creates it with
 * `depot.defaultCapacity` if it does not exist yet — that only happens the first time
 * the character visits that hold.
 * @param {object} conn connection with an active transaction
 * @param {number} characterId
 * @param {string} holdId
 * @param {object} deps
 */
async function _lockOrCreateDepot(conn, characterId, holdId, deps) {
  const [rows] = await conn.query(
    'SELECT id, capacity FROM character_depots WHERE character_id = ? AND hold_id = ? FOR UPDATE',
    [characterId, holdId]
  );
  if (rows.length > 0) return { id: rows[0].id, capacity: Number(rows[0].capacity) };

  const capacity = deps.serverOptions.get('depot.defaultCapacity');
  const [result] = await conn.query(
    'INSERT INTO character_depots (character_id, hold_id, capacity) VALUES (?, ?, ?)',
    [characterId, holdId, capacity]
  );
  return { id: result.insertId, capacity };
}

/**
 * @param {number} characterId
 * @param {string} holdId
 * @param {object} [dependencies]
 */
async function getOrCreateDepot(characterId, holdId, dependencies = {}) {
  const deps = _deps(dependencies);
  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();
    const depot = await _lockOrCreateDepot(conn, characterId, holdId, deps);
    await conn.commit();
    return depot;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * @param {number} characterId
 * @param {string} holdId
 * @param {object} [dependencies]
 */
async function getDepotContents(characterId, holdId, dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query(
    `SELECT di.base_id, di.count
       FROM depot_inventory di
       JOIN character_depots cd ON cd.id = di.depot_id
      WHERE cd.character_id = ? AND cd.hold_id = ?
      ORDER BY di.base_id`,
    [characterId, holdId]
  );
  return rows.map((r) => ({ baseId: Number(r.base_id), count: Number(r.count) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Depositing / withdrawing items
// ─────────────────────────────────────────────────────────────────────────────

async function _currentStackCount(conn, table, ownerColumn, ownerId, baseId) {
  const [rows] = await conn.query(
    `SELECT count FROM ${table} WHERE ${ownerColumn} = ? AND base_id = ? FOR UPDATE`,
    [ownerId, baseId]
  );
  return rows.length > 0 ? Number(rows[0].count) : 0;
}

async function _depotTotalCount(conn, depotId) {
  const [rows] = await conn.query(
    'SELECT COALESCE(SUM(count), 0) AS total FROM depot_inventory WHERE depot_id = ?',
    [depotId]
  );
  return Number(rows[0].total);
}

/**
 * Moves an item from the character's inventory into the region's depot.
 *
 * Refuses (`{ok:false, code}`) WITHOUT writing anything when the character does not have
 * enough stock or the depot would exceed `capacity` — same criterion as
 * `profession-service.grantProfession` against `maxPerCharacter`: the check
 * happens under the SAME lock the write would use, so there is no race between
 * "decided it fits" and "wrote it".
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.holdId
 * @param {number} opts.baseId
 * @param {number} opts.count
 * @param {object} [dependencies]
 */
async function depositItem(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, holdId, baseId, count } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (typeof holdId !== 'string' || !holdId) return { ok: false, code: 'invalid_hold' };
  if (!_isPositiveInt(baseId)) return { ok: false, code: 'invalid_item' };
  if (!_isPositiveInt(count)) return { ok: false, code: 'invalid_count' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const depot = await _lockOrCreateDepot(conn, characterId, holdId, deps);

    const carried = await _currentStackCount(conn, 'character_inventory', 'character_id', characterId, baseId);
    if (carried < count) {
      await conn.rollback();
      return { ok: false, code: 'insufficient_stock', data: { carried, requested: count } };
    }

    const currentTotal = await _depotTotalCount(conn, depot.id);
    if (currentTotal + count > depot.capacity) {
      await conn.rollback();
      return { ok: false, code: 'depot_full', data: { capacity: depot.capacity, current: currentTotal } };
    }

    await deps.tx.applyStackDelta(conn, 'character_inventory', characterId, baseId, -count);
    await deps.tx.applyStackDelta(conn, 'depot_inventory', depot.id, baseId, count);

    await conn.commit();
    return { ok: true, data: { depotId: depot.id, baseId, count } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Moves an item from the region's depot back into the character's inventory.
 * Symmetric to `depositItem` — same single transaction, same lock.
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.holdId
 * @param {number} opts.baseId
 * @param {number} opts.count
 * @param {object} [dependencies]
 */
async function withdrawItem(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, holdId, baseId, count } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (typeof holdId !== 'string' || !holdId) return { ok: false, code: 'invalid_hold' };
  if (!_isPositiveInt(baseId)) return { ok: false, code: 'invalid_item' };
  if (!_isPositiveInt(count)) return { ok: false, code: 'invalid_count' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [depotRows] = await conn.query(
      'SELECT id FROM character_depots WHERE character_id = ? AND hold_id = ? FOR UPDATE',
      [characterId, holdId]
    );
    if (depotRows.length === 0) {
      await conn.rollback();
      return { ok: false, code: 'depot_not_found' };
    }
    const depotId = depotRows[0].id;

    const stored = await _currentStackCount(conn, 'depot_inventory', 'depot_id', depotId, baseId);
    if (stored < count) {
      await conn.rollback();
      return { ok: false, code: 'insufficient_stock', data: { stored, requested: count } };
    }

    await deps.tx.applyStackDelta(conn, 'depot_inventory', depotId, baseId, -count);
    await deps.tx.applyStackDelta(conn, 'character_inventory', characterId, baseId, count);

    await conn.commit();
    return { ok: true, data: { depotId, baseId, count } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gold — read-only access to the existing global balance, no new reserve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number} characterId
 * @param {object} [dependencies]
 */
async function getGoldBalance(characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  const result = await deps.economy.getBalance({ type: 'character', ref: characterId }, dependencies);
  return result.ok ? result.balance : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Physical terminals — translates a world object's FormID into a hold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number} objectFormId FormID resolved by the Interaction Framework
 *   (`ctx.target.formId`, `core/interaction-targets.js` TARGET_TYPES.OBJECT)
 * @param {object} [dependencies]
 * @returns {Promise<string|null>} hold_id, or null if this object is not a depot terminal
 */
async function resolveTerminal(objectFormId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(objectFormId)) return null;
  // The terminal is identified by FormDesc (`"hex:Skyrim.esm"`), not by the
  // raw FormID — the same distinction `containers.object_id` already uses. The
  // FormID→FormDesc translation is the same one `core/papyrus.js` does for the `self` of a
  // Papyrus call: `mp.getDescFromId(formId)`.
  if (typeof mp === 'undefined' || typeof mp.getDescFromId !== 'function') return null;
  const objectId = mp.getDescFromId(objectFormId);
  const rows = await deps.db.query('SELECT hold_id FROM depot_terminals WHERE object_id = ?', [objectId]);
  return rows.length > 0 ? rows[0].hold_id : null;
}

async function listTerminalFormDescs(dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query('SELECT object_id FROM depot_terminals ORDER BY object_id');
  return rows.map((row) => row.object_id).filter((value) => typeof value === 'string' && value.includes(':'));
}

function registerPhysicalAnchors(dependencies = {}) {
  physicalAnchorRegistry.register({
    targetType: interactionRegistry.TARGET_TYPES.OBJECT,
    list: async () => {
      if (typeof mp === 'undefined' || typeof mp.getIdFromDesc !== 'function') return [];
      const formDescs = await listTerminalFormDescs(dependencies);
      return formDescs
        .map((formDesc) => mp.getIdFromDesc(formDesc))
        .filter((targetId) => Number.isSafeInteger(targetId) && targetId > 0)
        .map((targetId) => ({ targetId }));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction Framework — DEPOT_CHEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the payload the CEF uses to draw the whole panel — same shape
 * when opening (`depot:open`) and after every deposit/withdrawal (`depot:update`),
 * so a single client-side renderer serves both.
 * @param {number} characterId
 * @param {string} holdId
 * @param {number} targetFormId
 * @param {object} dependencies
 */
async function _panelPayload(characterId, holdId, targetFormId, dependencies) {
  const deps = _deps(dependencies);
  const depot = await getOrCreateDepot(characterId, holdId, dependencies);
  const contents = await getDepotContents(characterId, holdId, dependencies);
  const carried = await deps.inventory.list(inventoryOwner.character(characterId));
  const gold = await getGoldBalance(characterId, dependencies);
  // `targetId` comes back in the payload so the CEF can send `depot.deposit`/
  // `depot.withdraw` without depending on the generic interaction menu's state —
  // the depot panel is its own screen, not an extension of it.
  return { holdId, targetId: targetFormId, carried, contents, gold, capacity: depot.capacity };
}

/**
 * Registers the depot actions in the Interaction Framework. Called from the
 * module's `initialize()` — it needs the `interaction` framework already up, hence
 * `dependencies: ['interaction']` in `phase0-basic.js`.
 * @param {object} [dependencies] passed to every domain call — today only
 *   `sendModal` matters here (Task 10: UI-Depot-Bridge), the rest comes from the
 *   `_deps()` default.
 */
function registerInteractions(dependencies = {}) {
  const deps = _deps(dependencies);
  const comum = {
    module: MODULE_ID,
    target: interactionRegistry.TARGET_TYPES.OBJECT,
    section: 'deposito',
    distance: DEPOT_INTERACT_RANGE,
    // The object is only a valid depot target if it is in depot_terminals.
    // An arbitrary MpObjectReference (a rock, a dead NPC) never shows up
    // in the interaction menu through this path.
    canSee: async (ctx) => Boolean(await resolveTerminal(ctx.target.formId, dependencies))
  };

  interactionRegistry.register({
    ...comum,
    id: 'depot.view',
    label: 'View depot',
    order: 10,
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    execute: async (ctx) => {
      const holdId = await resolveTerminal(ctx.target.formId, dependencies);
      if (!holdId) throw new Error('This object is not a depot terminal.');
      const payload = await _panelPayload(ctx.characterId, holdId, ctx.target.formId, dependencies);
      // The CEF does not draw anything from `execute`'s return value yet (it just becomes
      // a chat notification — `interaction-service.js` handleUiEvent). The
      // channel that actually opens the screen is `sendModal`, the same one used by
      // `interaction:actions`.
      deps.sendModal(ctx.actorId, 'depot:open', payload);
      return { message: null };
    }
  });

  interactionRegistry.register({
    ...comum,
    id: 'depot.deposit',
    label: 'Deposit item',
    order: 20,
    audit: interactionRegistry.AUDIT_LEVELS.ECONOMY,
    schema: {
      baseId: { type: 'formid', label: 'Item', required: true },
      count: { type: 'int', label: 'Quantity', min: 1, default: 1 }
    },
    execute: async (ctx) => {
      const holdId = await resolveTerminal(ctx.target.formId, dependencies);
      if (!holdId) throw new Error('This object is not a depot terminal.');
      const result = await depositItem(
        { characterId: ctx.characterId, holdId, baseId: ctx.data.baseId, count: ctx.data.count },
        dependencies
      );
      if (result.ok) {
        const payload = await _panelPayload(ctx.characterId, holdId, ctx.target.formId, dependencies);
        deps.sendModal(ctx.actorId, 'depot:update', payload);
      }
      return result;
    }
  });

  interactionRegistry.register({
    ...comum,
    id: 'depot.withdraw',
    label: 'Withdraw item',
    order: 30,
    audit: interactionRegistry.AUDIT_LEVELS.ECONOMY,
    schema: {
      baseId: { type: 'formid', label: 'Item', required: true },
      count: { type: 'int', label: 'Quantity', min: 1, default: 1 }
    },
    execute: async (ctx) => {
      const holdId = await resolveTerminal(ctx.target.formId, dependencies);
      if (!holdId) throw new Error('This object is not a depot terminal.');
      const result = await withdrawItem(
        { characterId: ctx.characterId, holdId, baseId: ctx.data.baseId, count: ctx.data.count },
        dependencies
      );
      if (result.ok) {
        const payload = await _panelPayload(ctx.characterId, holdId, ctx.target.formId, dependencies);
        deps.sendModal(ctx.actorId, 'depot:update', payload);
      }
      return result;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat command — fallback while there is no dedicated CEF UI (brief §6)
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: '/depot',
      description: 'Shows the contents of your regional depot (must be near a depot terminal)',
      usage: '/depot',
      handler: async (actorId) => {
        const commands = require('../commands');
        const personagem = commands.getActiveCharacterData(actorId);
        if (!personagem) return;
        commands.sendNotification(
          actorId,
          '[Depot] Use the interaction menu near a registered depot chest.'
        );
      }
    }
  ];
}

module.exports = {
  MODULE_ID,
  DEPOT_INTERACT_RANGE,
  getOrCreateDepot,
  getDepotContents,
  depositItem,
  withdrawItem,
  getGoldBalance,
  resolveTerminal,
  listTerminalFormDescs,
  registerPhysicalAnchors,
  registerInteractions,
  commandDefs
};
