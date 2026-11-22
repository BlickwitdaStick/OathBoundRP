/**
 * resource-node-service.js
 *
 * **The Resource Node Framework.** A resource node (ore vein, tree) with
 * capacity, regeneration computed on demand, and a single write
 * operation — `consume` — that decrements the node and delivers the item in a single
 * transaction. No mining, tree felling or hunting lives here: this is the
 * generic engine a concrete profession (Miner, Lumberjack) will call
 * after having already checked distance, tool and gathering session — none
 * of those three checks belongs to this file.
 *
 * ─── Why `consume` delivers the item in the SAME transaction that decrements the node ─
 *
 * If they were two transactions (decrement the node, then `transactionService
 * .giveItem`), a failure between the two would leave the node poorer and the player
 * empty-handed — a resource destroyed with nobody receiving it. `core
 * /transaction-service.js` already solves exactly that problem for whoever
 * needs to commit two effects together: it exports `tx.*`, primitives that
 * take part in the **caller's** transaction instead of opening their own. It is the
 * same pattern `crafting-service.js` uses to consume ingredients and
 * deliver the result in one go.
 *
 * ─── Concurrency: why locking by `id` is enough ─────────────────────────────
 *
 * Unlike `profession-service.grantProfession` (which has to lock
 * ALL of the character's active rows to count against a limit),
 * `consume` only needs the node's OWN row: `SELECT ... WHERE id = ? FOR
 * UPDATE` serializes two players fighting over the same vein — the second reads the
 * capacity already decremented by the first, not the stale one. It is §25 of the
 * professions briefing ("neither capacity = -1 nor duplication"), solved by the
 * same mechanism `core/transaction-service._applyGoldDelta` already uses for
 * gold.
 */

'use strict';

const database = require('./database');
const transactionService = require('./core/transaction-service');
const professionService = require('./profession-service');
const { isValidType } = require('./core/resource-node-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Forma do FormDesc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hex WITHOUT the `0x` prefix, a colon, the file name — the project's CLAUDE.md
 * convention ("cell and base are '162e2:Skyrim.esm'"). Validated here for the
 * same reason the document records it: a `0x162e2` throws no error
 * anywhere in Papyrus, it just stops working in game.
 */
const FORM_DESC_SHAPE = /^[0-9a-f]{1,8}:[^:]+\.(esm|esp|esl)$/i;

function isValidFormDesc(v) {
  return typeof v === 'string' && FORM_DESC_SHAPE.test(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    transactionService: dependencies.transactionService || transactionService,
    professionService: dependencies.professionService || professionService
  };
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

/**
 * Current capacity, computed — never written here. `elapsedMs` since
 * `last_updated_at`, converted into units by `regen_per_hour`, rounded
 * down (regenerating 0.9 of a unit is regenerating nothing), added to the
 * stored capacity, capped at `max_capacity`.
 *
 * @param {{current_capacity:number, max_capacity:number, regen_per_hour:number, last_updated_at:Date|string}} row
 * @param {number} nowMs
 */
function _computeCapacity(row, nowMs) {
  const gravada = Number(row.current_capacity);
  if (gravada >= row.max_capacity) return row.max_capacity;
  const atualizadoEm = new Date(row.last_updated_at).getTime();
  const elapsedMs = Math.max(0, nowMs - atualizadoEm);
  const regenerado = Math.floor((elapsedMs / 3_600_000) * row.regen_per_hour);
  return Math.min(row.max_capacity, gravada + regenerado);
}

function _rowToState(row, nowMs) {
  if (!row) return null;
  const capacity = _computeCapacity(row, nowMs);
  return {
    id: row.id,
    formDesc: row.form_desc,
    type: row.type,
    resourceBaseId: row.resource_base_id,
    yieldPerAction: row.yield_per_action,
    capacity,
    maxCapacity: row.max_capacity,
    regenPerHour: row.regen_per_hour,
    requiredProfession: row.required_profession,
    requiredRank: row.required_rank,
    enabled: !!row.enabled,
    state: capacity > 0 ? 'available' : 'depleted'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Creation / administration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a new node. It goes through no capability or admin-action in this phase —
 * there is no in-game tool today to place a node (that is
 * work for a future phase, when Miner really needs it); until then
 * this is called by a seed script, under review, the same way `crafting_recipes` is
 * seeded by `seed-forging.sql`.
 *
 * @param {object} opts
 * @param {string} opts.formDesc
 * @param {string} opts.type one of core/resource-node-registry.NODE_TYPES
 * @param {number} opts.resourceBaseId
 * @param {number} opts.maxCapacity
 * @param {number} [opts.yieldPerAction] default 1
 * @param {number} [opts.regenPerHour] default 0
 * @param {string|null} [opts.requiredProfession]
 * @param {number|null} [opts.requiredRank]
 * @param {object} [dependencies]
 */
async function createNode(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const {
    formDesc, type, resourceBaseId, maxCapacity,
    yieldPerAction = 1, regenPerHour = 0,
    requiredProfession = null, requiredRank = null
  } = opts || {};

  if (!isValidFormDesc(formDesc)) return { ok: false, code: 'invalid_form_desc' };
  if (!isValidType(type)) return { ok: false, code: 'invalid_type' };
  if (!_isPositiveInt(resourceBaseId)) return { ok: false, code: 'invalid_resource_base_id' };
  if (!_isPositiveInt(maxCapacity)) return { ok: false, code: 'invalid_max_capacity' };
  if (!Number.isSafeInteger(yieldPerAction) || yieldPerAction <= 0) return { ok: false, code: 'invalid_yield' };
  if (!Number.isSafeInteger(regenPerHour) || regenPerHour < 0) return { ok: false, code: 'invalid_regen' };
  if (requiredRank !== null && (!Number.isInteger(requiredRank) || requiredRank < 0)) {
    return { ok: false, code: 'invalid_required_rank' };
  }

  const existing = await deps.db.query('SELECT id FROM resource_nodes WHERE form_desc = ?', [formDesc]);
  if (existing.length > 0) return { ok: false, code: 'form_desc_taken' };

  const result = await deps.db.query(
    `INSERT INTO resource_nodes
      (form_desc, type, resource_base_id, yield_per_action, max_capacity, current_capacity,
       regen_per_hour, required_profession, required_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [formDesc, type, resourceBaseId, yieldPerAction, maxCapacity, maxCapacity, regenPerHour, requiredProfession, requiredRank]
  );

  return { ok: true, data: { id: result.insertId } };
}

/** @param {string} formDesc @param {boolean} enabled @param {object} [dependencies] */
async function setNodeEnabled(formDesc, enabled, dependencies = {}) {
  const deps = _deps(dependencies);
  const result = await deps.db.query('UPDATE resource_nodes SET enabled = ? WHERE form_desc = ?', [enabled ? 1 : 0, formDesc]);
  return { ok: result.affectedRows > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consulta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current state of the node, with the capacity ALREADY recomputed — a pure read, it
 * writes nothing. @param {string} formDesc @param {object} [dependencies]
 */
async function getNode(formDesc, dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query('SELECT * FROM resource_nodes WHERE form_desc = ?', [formDesc]);
  return rows.length > 0 ? _rowToState(rows[0], Date.now()) : null;
}

/** Minimal list for physical discovery by the prompt; does not expose the reward. */
async function listEnabledNodes(dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query(
    'SELECT form_desc FROM resource_nodes WHERE enabled = 1 ORDER BY id'
  );
  return rows
    .map((row) => row.form_desc)
    .filter(isValidFormDesc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consumes one gather from the node and delivers the item, atomically.
 *
 * Typed result, same convention as `profession-service.js`: `{ok:true,
 * data}` for success, `{ok:false, code}` for an expected refusal (depleted node,
 * disabled, profession/rank gate), and it THROWS for an infrastructure failure.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {number} [opts.actorId] only needed to reflect it on the client (see
 *   `transactionService.tx.applyToClient`); if omitted, the item is correct in the
 *   DB and reconciled on the next login, same behavior as
 *   `transaction-service.giveItem`.
 * @param {string} opts.formDesc
 * @param {string} opts.requestId opaque identifier of the attempt
 * @param {number} [opts.cooldownMs] authoritative interval per character/node
 * @param {object} [dependencies]
 */
async function consume(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, actorId = null, formDesc, requestId, cooldownMs = 0 } = opts || {};

  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (!isValidFormDesc(formDesc)) return { ok: false, code: 'invalid_form_desc' };
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 48) {
    return { ok: false, code: 'invalid_request_id' };
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 3_600_000) {
    return { ok: false, code: 'invalid_cooldown' };
  }

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM resource_nodes WHERE form_desc = ? FOR UPDATE', [formDesc]);
    const row = rows[0] || null;
    if (!row) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (!row.enabled) {
      await conn.rollback();
      return { ok: false, code: 'node_disabled' };
    }

    const idempotencyKey = `resource-node:${characterId}:${requestId}`;
    const [replays] = await conn.query(
      'SELECT transaction_id FROM inventory_transactions WHERE idempotency_key = ? LIMIT 1',
      [idempotencyKey]
    );
    if (replays.length > 0) {
      await conn.rollback();
      return { ok: true, replay: true, data: { formDesc } };
    }

    if (cooldownMs > 0) {
      const [gathers] = await conn.query(
        `SELECT last_gathered_at FROM resource_node_gathers
         WHERE resource_node_id = ? AND character_id = ? FOR UPDATE`,
        [row.id, characterId]
      );
      if (gathers.length > 0) {
        const elapsedMs = Date.now() - new Date(gathers[0].last_gathered_at).getTime();
        if (elapsedMs < cooldownMs) {
          await conn.rollback();
          return { ok: false, code: 'cooldown', data: { retryAfterMs: cooldownMs - Math.max(0, elapsedMs) } };
        }
      }
    }

    if (row.required_profession) {
      const tem = await deps.professionService.hasProfession(characterId, row.required_profession, { db: deps.db });
      if (!tem) {
        await conn.rollback();
        return { ok: false, code: 'profession_required', data: { required: row.required_profession } };
      }
      if (row.required_rank !== null) {
        const estado = await deps.professionService.getProfessionState(characterId, row.required_profession, { db: deps.db });
        if (!estado || estado.rank < row.required_rank) {
          await conn.rollback();
          return { ok: false, code: 'rank_too_low', data: { required: row.required_rank, current: estado ? estado.rank : 0 } };
        }
      }
    }

    const nowMs = Date.now();
    const capacidadeAtual = _computeCapacity(row, nowMs);
    if (capacidadeAtual < row.yield_per_action) {
      // Still writes the recomputed capacity — without it, an idle node (with
      // nobody trying to harvest) never advances `last_updated_at`, and the next
      // attempt would recompute from an ever older instant. That is
      // mathematically harmless (the calculation is always "since the last stored
      // value", not "since forever"), but writing here keeps the data on disk
      // honest for whoever queries `getNode` directly in the DB.
      await conn.query(
        'UPDATE resource_nodes SET current_capacity = ?, last_updated_at = ? WHERE id = ?',
        [capacidadeAtual, new Date(nowMs), row.id]
      );
      await conn.commit();
      return { ok: false, code: 'depleted', data: { capacity: capacidadeAtual } };
    }

    const novaCapacidade = capacidadeAtual - row.yield_per_action;
    await conn.query(
      'UPDATE resource_nodes SET current_capacity = ?, last_updated_at = ? WHERE id = ?',
      [novaCapacidade, new Date(nowMs), row.id]
    );

    // Same transaction: the resource only leaves the node if the item enters the inventory.
    await deps.transactionService.tx.applyInventoryDelta(conn, characterId, row.resource_base_id, row.yield_per_action);
    await deps.transactionService.tx.recordInventoryLedger(conn, {
      characterId,
      baseId: row.resource_base_id,
      delta: row.yield_per_action,
      reason: `resource_node:${formDesc}`,
      module: 'resource-node',
      idempotencyKey
    });

    if (cooldownMs > 0) {
      await conn.query(
        `INSERT INTO resource_node_gathers (resource_node_id, character_id, last_gathered_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_gathered_at = VALUES(last_gathered_at)`,
        [row.id, characterId, new Date(nowMs)]
      );
    }

    await conn.commit();

    // After the commit, same as `transaction-service.giveItem` — the DB is the
    // source of truth, the client is reconciled if this fails.
    deps.transactionService.tx.applyToClient(actorId, row.resource_base_id, row.yield_per_action);

    return {
      ok: true,
      data: {
        formDesc,
        resourceBaseId: row.resource_base_id,
        yield: row.yield_per_action,
        capacity: novaCapacidade,
        maxCapacity: row.max_capacity
      }
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  isValidFormDesc,
  createNode,
  setNodeEnabled,
  getNode,
  listEnabledNodes,
  consume,
  // Exposed only for tests.
  _computeCapacity,
  _rowToState
};
