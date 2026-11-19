/**
 * contracts-service.js
 *
 * Contracts between players: someone posts work, someone accepts it, the server
 * moves the septims and keeps the record. No automatic arbitration, no staff
 * queue, no NPC.
 *
 * Registered in `phase0-basic.js` as the `contracts` module (phase `lab`,
 * `ENABLE_CONTRACTS_SERVICE`, off by default). It still has no CEF UI —
 * the chat commands at the end of this file (`commandDefs()`) are the whole
 * interface — and still has no automatic arbitration: `dispute` locks the escrow and
 * waits for a human decision. Nothing here had been seen on a server with people in it
 * as of 2026-08-20; validate it on the bench before taking the flag out of off in
 * production. See `PARKED_SERVICES_DECISION.md` for the history of the decision to
 * leave it parked, and `docs/technical/FASE_0_ROTEIRO.md` for the overall state of the
 * project regarding testing on a real server.
 *
 * Design: `docs/gameplay/CONTRACTS.md`
 * Economy decision: `docs/technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md`
 * Origin of the concept: Mereth Roleplay — **no license and no public code**,
 * so this is a reimplementation from the published idea, not a port
 * (`docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md` §4).
 *
 * ─── The machine ────────────────────────────────────────────────────────────
 *
 *              ┌──────────► cancelled   (creator gives up; escrow refunded)
 *              │
 *   open ──────┼──────────► expired     (deadline passed; escrow refunded)
 *     │        │
 *     ▼        │
 *   accepted ──┘──────────► expired     (deadline passed; escrow refunded)
 *     │
 *     ▼
 *   delivered ────────────► settled     (escrow → worker)
 *     │
 *     └────────────────────► disputed   (escrow STAYS locked; nobody gets paid)
 *
 * ─── The three non-negotiable rules ────────────────────────────────────────
 *
 * 1. **Escrow locks at posting.** `open` only exists with the value already out of the
 *    creator's pocket. A failure during creation produces NO CONTRACT, never a contract that
 *    nobody can pay.
 * 2. **Expiry never touches delivered work.** `delivered` and `disputed` are
 *    outside the sweep. Without that, letting it expire after receiving the work is the exploit.
 * 3. **`disputed` decides nothing.** The escrow stays locked and staff resolve it
 *    outside the automation. Irreversible consequences are not automated
 *    (briefing §11).
 */

const crypto = require('crypto');
const database = require('./database');
const economyService = require('./core/economy-service');
const commands = require('./commands');

const MODULE = 'contracts';

/**
 * Categories from briefing §9. The list is open through editing, not through the payload: a
 * `category` coming from the UI that is not here is refused, because it becomes a
 * listing filter and an RP label, and a free-form value turns the listing into
 * garbage.
 *
 * Adding a category is **only** editing this list — the framework does not
 * verify the work of any of them. Verification by item count exists
 * for item delivery (`core/inventory.js`); "killed the bandit" and "escorted the
 * caravan" are human confirmations by the creator, and pretending otherwise would be
 * promising an omniscience the server does not have.
 */
const CATEGORIES = Object.freeze([
  'mercenary', 'caravan', 'delivery', 'bodyguard', 'crafting',
  'mining', 'harvest', 'hunt', 'arcane', 'investigation', 'generic'
]);

const STATUS = Object.freeze({
  OPEN: 'open',
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered',
  SETTLED: 'settled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  DISPUTED: 'disputed'
});

/** States the expiry sweep may touch. See rule 2 in the header. */
const EXPIRABLE = Object.freeze([STATUS.OPEN, STATUS.ACCEPTED]);

/** Default window between `delivered` and automatic settlement. */
const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000;

const MIN_REWARD = 1;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function positiveId(value) {
  const id = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function normalizeKey(value) {
  return economyService.normalizeIdempotencyKey(value);
}

async function _safeRollback(conn) {
  try { await conn.rollback(); } catch { /* keep the original error */ }
}

async function _withTransaction(dependencies, fn) {
  const db = dependencies.db || database;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    committed = true;
    return result;
  } catch (err) {
    if (!committed) await _safeRollback(conn);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Reads and locks the contract. Everything that changes state goes through here first — it is the
 * lock that makes a simultaneous "accept" and "cancel" serialize instead of
 * both reading `open`.
 */
async function _lockContract(conn, contractId) {
  const [rows] = await conn.query(
    `SELECT id, creator_character_id, accepted_by_character_id, reward, escrow_id,
            status, review_until, expires_at
       FROM contracts WHERE id = ? FOR UPDATE`,
    [contractId]
  );
  return rows[0] || null;
}

/**
 * Writes the transition. `idempotency_key` is UNIQUE, so the same request resent
 * does not create two events — and the query below makes the replay return the
 * original result instead of `invalid_status` (Finding 7 of the economy audit).
 */
async function _recordEvent(conn, params) {
  await conn.query(
    `INSERT INTO contract_events
      (contract_id, from_status, to_status, actor_character_id, reason, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [params.contractId, params.from, params.to, params.actorCharacterId || null,
      params.reason || null, params.idempotencyKey || null]
  );
}

async function _findEventReplay(conn, idempotencyKey) {
  const [rows] = await conn.query(
    'SELECT contract_id, from_status, to_status FROM contract_events WHERE idempotency_key = ? FOR UPDATE',
    [idempotencyKey]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posts a contract. The escrow is funded **before** the row in `contracts`
 * exists, in the same transaction: if the creator does not have the gold, no contract is left.
 *
 * @param {object} request
 * @param {number} request.creatorCharacterId
 * @param {string} request.title
 * @param {string} [request.description]
 * @param {string} [request.category]
 * @param {number} request.reward septims locked in escrow
 * @param {number} [request.expiresInMs]
 * @param {string} [request.idempotencyKey]
 */
async function create(request, dependencies = {}) {
  const economy = dependencies.economy || economyService;
  const creatorCharacterId = positiveId(request?.creatorCharacterId);
  const title = normalizeText(request?.title, 96);
  const reward = economy.normalizeAmount(request?.reward);
  const idempotencyKey = normalizeKey(request?.idempotencyKey);
  const category = request?.category === undefined ? 'generic' : request.category;
  const description = request?.description === undefined || request.description === null
    ? null
    : normalizeText(request.description, 2000);

  if (!creatorCharacterId) return { ok: false, code: 'invalid_creator' };
  if (!title) return { ok: false, code: 'invalid_title' };
  if (!reward || reward < MIN_REWARD) return { ok: false, code: 'invalid_reward' };
  if (!CATEGORIES.includes(category)) return { ok: false, code: 'invalid_category' };
  if (request?.description !== undefined && request?.description !== null && !description) {
    return { ok: false, code: 'invalid_description' };
  }
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  const expiresInMs = request?.expiresInMs;
  if (expiresInMs !== undefined && (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0)) {
    return { ok: false, code: 'invalid_expiry' };
  }
  const now = dependencies.now ? dependencies.now() : Date.now();
  const expiresAt = expiresInMs ? new Date(now + expiresInMs) : null;

  return _withTransaction(dependencies, async conn => {
    // The creation event is written last, so finding it proves the whole
    // creation committed. It is the same replay marker all the
    // other transitions use — a second mechanism just for `create` would be
    // one more thing capable of disagreeing with the rest.
    const prior = await _findEventReplay(conn, `${idempotencyKey}~open`);
    if (prior) {
      return { ok: true, replayed: true, contractId: prior.contract_id };
    }

    const escrow = await economy.openEscrowInTransaction(conn, {
      funder: { type: 'character', ref: creatorCharacterId },
      amount: reward,
      purpose: 'contract',
      reason: 'contract_escrow',
      module: MODULE,
      actorCharacterId: creatorCharacterId,
      idempotencyKey: `${idempotencyKey}~escrow`
    }, dependencies);

    // Fail-closed: the value did not lock, so no contract is born. It is the
    // difference between "no contract" and "a contract nobody can pay".
    if (!escrow.ok) return escrow;

    const [insert] = await conn.query(
      `INSERT INTO contracts
        (creator_character_id, title, description, category, reward, escrow_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [creatorCharacterId, title, description, category, reward, escrow.escrowId, STATUS.OPEN, expiresAt]
    );
    const contractId = insert.insertId;

    await _recordEvent(conn, {
      contractId, from: null, to: STATUS.OPEN,
      actorCharacterId: creatorCharacterId,
      reason: 'created', idempotencyKey: `${idempotencyKey}~open`
    });

    return { ok: true, replayed: false, contractId, escrowId: escrow.escrowId, reward, expiresAt };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions that do not touch money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory for the simple transitions. They all have the same shape: lock the contract,
 * check replay, check state and author, write the event and update the row.
 *
 * Centralizing this is not about saving keystrokes — it is what guarantees no
 * transition forgets the `FOR UPDATE` or the replay check, which are the two
 * things whose absence does not show up in sequential tests.
 */
function makeTransition(config) {
  return async function transition(request, dependencies = {}) {
    const contractId = positiveId(request?.contractId);
    const actorCharacterId = positiveId(request?.actorCharacterId);
    const idempotencyKey = normalizeKey(request?.idempotencyKey);

    if (!contractId) return { ok: false, code: 'invalid_contract' };
    if (!actorCharacterId) return { ok: false, code: 'invalid_actor' };
    if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

    return _withTransaction(dependencies, async conn => {
      const contract = await _lockContract(conn, contractId);
      if (!contract) return { ok: false, code: 'contract_not_found' };

      const prior = await _findEventReplay(conn, idempotencyKey);
      if (prior) {
        return { ok: true, replayed: true, contractId, status: prior.to_status };
      }

      if (contract.status !== config.from) {
        return { ok: false, code: 'invalid_status', status: contract.status };
      }
      const denial = config.authorize(contract, actorCharacterId);
      if (denial) return { ok: false, code: denial };

      const now = dependencies.now ? dependencies.now() : Date.now();
      const patch = config.patch(contract, actorCharacterId, now);
      const columns = Object.keys(patch);
      const setClause = ['status = ?', ...columns.map(c => `${c} = ?`)].join(', ');
      // The `AND status = ?` is redundant with the check above **under the lock** — and
      // that is on purpose: if someone removes the `FOR UPDATE` from `_lockContract`, the
      // update starts affecting 0 rows instead of overwriting another
      // transaction's transition.
      await conn.query(
        `UPDATE contracts SET ${setClause} WHERE id = ? AND status = ?`,
        [config.to, ...columns.map(c => patch[c]), contractId, config.from]
      );

      await _recordEvent(conn, {
        contractId, from: config.from, to: config.to,
        actorCharacterId, reason: config.reason, idempotencyKey
      });

      return { ok: true, replayed: false, contractId, status: config.to };
    });
  };
}

/**
 * Accept. The creator cannot accept their own contract — without that rule, the
 * contract becomes a way to move gold to yourself with a stamp of
 * legitimacy, which is exactly what a laundering scheme looks for.
 */
const accept = makeTransition({
  from: STATUS.OPEN,
  to: STATUS.ACCEPTED,
  reason: 'accepted',
  authorize: (contract, actor) => (contract.creator_character_id === actor ? 'creator_cannot_accept' : null),
  patch: (_contract, actor, now) => ({ accepted_by_character_id: actor, accepted_at: new Date(now) })
});

/**
 * Declare delivery. Only whoever accepted. Opens the review window — once it passes with no
 * dispute, settlement is automatic.
 */
const deliver = makeTransition({
  from: STATUS.ACCEPTED,
  to: STATUS.DELIVERED,
  reason: 'delivered',
  authorize: (contract, actor) => (contract.accepted_by_character_id !== actor ? 'not_the_worker' : null),
  patch: (_contract, _actor, now) => ({
    delivered_at: new Date(now),
    review_until: new Date(now + REVIEW_WINDOW_MS)
  })
});

/**
 * Dispute the delivery. **It decides nothing**: the escrow stays locked and neither
 * of the two gets paid until someone outside resolves it. It is the only exit from `delivered`
 * that does not move money, and it is that way on purpose — automating "who is right"
 * is the irreversible consequence briefing §11 forbids.
 */
const dispute = makeTransition({
  from: STATUS.DELIVERED,
  to: STATUS.DISPUTED,
  reason: 'disputed',
  authorize: (contract, actor) => (contract.creator_character_id !== actor ? 'not_the_creator' : null),
  // Nothing but the status changes: `closed_at` stays null because the contract did **not**
  // close — the escrow stays locked waiting for a human decision.
  patch: () => ({})
});

// ─────────────────────────────────────────────────────────────────────────────
// Transitions that move money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closes the contract by releasing the escrow. It is the common body of `settle`, `cancel` and
 * `expire` — all three are "change the status and empty the escrow to someone", and the
 * only difference is who receives it and from which state.
 */
async function _closeWithEscrow(conn, params, dependencies) {
  const economy = dependencies.economy || economyService;
  const contract = params.contract;

  const released = await economy.closeEscrowInTransaction(conn, {
    escrowId: contract.escrow_id,
    beneficiary: { type: 'character', ref: params.beneficiaryCharacterId },
    reason: params.reason,
    module: MODULE,
    actorCharacterId: params.actorCharacterId,
    idempotencyKey: `${params.idempotencyKey}~escrow`
  }, dependencies);

  if (!released.ok) return released;

  const now = params.now;
  await conn.query(
    'UPDATE contracts SET status = ?, closed_at = ? WHERE id = ? AND status = ?',
    [params.to, new Date(now), contract.id, contract.status]
  );
  await _recordEvent(conn, {
    contractId: contract.id, from: contract.status, to: params.to,
    actorCharacterId: params.actorCharacterId,
    reason: params.reason, idempotencyKey: params.idempotencyKey
  });

  return {
    ok: true, replayed: false, contractId: contract.id, status: params.to,
    amount: released.amount, transferId: released.transferId
  };
}

/**
 * Settlement: the escrow goes to whoever did the work.
 *
 * Who can ask for it: the creator (at any moment after `delivered`) or the
 * server, through the sweep, after the review window. The worker **cannot**
 * pay themselves — that would be declaring delivery and cashing out in the same breath.
 */
async function settle(request, dependencies = {}) {
  const contractId = positiveId(request?.contractId);
  const idempotencyKey = normalizeKey(request?.idempotencyKey);
  const bySweep = request?.bySweep === true;
  const actorCharacterId = bySweep ? null : positiveId(request?.actorCharacterId);

  if (!contractId) return { ok: false, code: 'invalid_contract' };
  if (!bySweep && !actorCharacterId) return { ok: false, code: 'invalid_actor' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  return _withTransaction(dependencies, async conn => {
    const contract = await _lockContract(conn, contractId);
    if (!contract) return { ok: false, code: 'contract_not_found' };

    const prior = await _findEventReplay(conn, idempotencyKey);
    if (prior) return { ok: true, replayed: true, contractId, status: prior.to_status };

    if (contract.status !== STATUS.DELIVERED) {
      return { ok: false, code: 'invalid_status', status: contract.status };
    }
    if (!bySweep && contract.creator_character_id !== actorCharacterId) {
      return { ok: false, code: 'not_the_creator' };
    }

    const now = dependencies.now ? dependencies.now() : Date.now();
    if (bySweep && contract.review_until && now < new Date(contract.review_until).getTime()) {
      return { ok: false, code: 'review_window_open' };
    }

    return _closeWithEscrow(conn, {
      contract, to: STATUS.SETTLED,
      beneficiaryCharacterId: contract.accepted_by_character_id,
      actorCharacterId, idempotencyKey, now,
      reason: 'contract_settlement'
    }, dependencies);
  });
}

/**
 * Cancel. Only while `open` — once someone accepted, cancelling
 * unilaterally would leave the worker with work done and no recourse. An
 * accepted contract that goes wrong exits through `expired` (the deadline) or through an agreement outside
 * the system.
 */
async function cancel(request, dependencies = {}) {
  const contractId = positiveId(request?.contractId);
  const actorCharacterId = positiveId(request?.actorCharacterId);
  const idempotencyKey = normalizeKey(request?.idempotencyKey);

  if (!contractId) return { ok: false, code: 'invalid_contract' };
  if (!actorCharacterId) return { ok: false, code: 'invalid_actor' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  return _withTransaction(dependencies, async conn => {
    const contract = await _lockContract(conn, contractId);
    if (!contract) return { ok: false, code: 'contract_not_found' };

    const prior = await _findEventReplay(conn, idempotencyKey);
    if (prior) return { ok: true, replayed: true, contractId, status: prior.to_status };

    if (contract.status !== STATUS.OPEN) {
      return { ok: false, code: 'invalid_status', status: contract.status };
    }
    if (contract.creator_character_id !== actorCharacterId) {
      return { ok: false, code: 'not_the_creator' };
    }

    return _closeWithEscrow(conn, {
      contract, to: STATUS.CANCELLED,
      beneficiaryCharacterId: contract.creator_character_id,
      actorCharacterId, idempotencyKey,
      now: dependencies.now ? dependencies.now() : Date.now(),
      reason: 'contract_cancelled'
    }, dependencies);
  });
}

/**
 * Expires a contract and refunds the escrow to the creator.
 *
 * ─── The rule that protects the worker ─────────────────────────────────────
 *
 * `EXPIRABLE` does not include `delivered` or `disputed`. Without that, a creator who
 * received the work only needs to wait out the clock to get the gold back — it is the
 * obvious exploit, and the defense against it is a list, not a comment.
 */
async function expire(request, dependencies = {}) {
  const contractId = positiveId(request?.contractId);
  const idempotencyKey = normalizeKey(request?.idempotencyKey);

  if (!contractId) return { ok: false, code: 'invalid_contract' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  return _withTransaction(dependencies, async conn => {
    const contract = await _lockContract(conn, contractId);
    if (!contract) return { ok: false, code: 'contract_not_found' };

    const prior = await _findEventReplay(conn, idempotencyKey);
    if (prior) return { ok: true, replayed: true, contractId, status: prior.to_status };

    if (!EXPIRABLE.includes(contract.status)) {
      return { ok: false, code: 'not_expirable', status: contract.status };
    }
    const now = dependencies.now ? dependencies.now() : Date.now();
    if (!contract.expires_at || now < new Date(contract.expires_at).getTime()) {
      return { ok: false, code: 'not_yet_expired' };
    }

    return _closeWithEscrow(conn, {
      contract, to: STATUS.EXPIRED,
      beneficiaryCharacterId: contract.creator_character_id,
      actorCharacterId: null, idempotencyKey, now,
      reason: 'contract_expired'
    }, dependencies);
  });
}

/**
 * Sweep. One transaction per contract on purpose: one transaction for all of them
 * would turn a single problematic row into no expiry processed at all.
 */
async function sweepExpired(dependencies = {}) {
  const db = dependencies.db || database;
  const now = dependencies.now ? dependencies.now() : Date.now();
  const rows = await db.query(
    `SELECT id FROM contracts
      WHERE status IN (?, ?) AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT 100`,
    [STATUS.OPEN, STATUS.ACCEPTED, new Date(now)]
  );

  const processed = [];
  for (const row of rows) {
    // The key derives from the contract, so rerunning the sweep in the same minute
    // neither expires twice nor refunds the escrow twice.
    const result = await expire({
      contractId: row.id,
      idempotencyKey: `sweep-expire-${row.id}`
    }, dependencies);
    processed.push({ contractId: row.id, ok: result.ok, code: result.code });
  }
  return { ok: true, processed };
}

/**
 * Automatic settlement of delivered contracts whose review window passed with no dispute.
 * It is the other side of the sweep: without it, a creator who disappears leaves the worker
 * with the gold locked forever.
 */
async function sweepReviewed(dependencies = {}) {
  const db = dependencies.db || database;
  const now = dependencies.now ? dependencies.now() : Date.now();
  const rows = await db.query(
    `SELECT id FROM contracts
      WHERE status = ? AND review_until IS NOT NULL AND review_until <= ?
      ORDER BY review_until LIMIT 100`,
    [STATUS.DELIVERED, new Date(now)]
  );

  const processed = [];
  for (const row of rows) {
    const result = await settle({
      contractId: row.id,
      bySweep: true,
      idempotencyKey: `sweep-settle-${row.id}`
    }, dependencies);
    processed.push({ contractId: row.id, ok: result.ok, code: result.code });
  }
  return { ok: true, processed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

async function listOpen(dependencies = {}) {
  const db = dependencies.db || database;
  return db.query(
    `SELECT id, creator_character_id, title, category, reward, expires_at, created_at
       FROM contracts WHERE status = ? ORDER BY created_at DESC LIMIT 50`,
    [STATUS.OPEN]
  );
}

async function getContract(contractId, dependencies = {}) {
  const db = dependencies.db || database;
  const id = positiveId(contractId);
  if (!id) return null;
  const rows = await db.query('SELECT * FROM contracts WHERE id = ?', [id]);
  return rows[0] || null;
}

async function history(contractId, dependencies = {}) {
  const db = dependencies.db || database;
  const id = positiveId(contractId);
  if (!id) return [];
  return db.query(
    'SELECT from_status, to_status, actor_character_id, reason, created_at FROM contract_events WHERE contract_id = ? ORDER BY id',
    [id]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat commands — the whole interface, no CEF UI (same pattern as
// `trade-service.commandDefs()`). Each handler resolves `actorId` → `characterId`
// through `commands.js` and generates its own `idempotencyKey`: a double click or a
// network resend becomes a replay, never a second transition.
// ─────────────────────────────────────────────────────────────────────────────

function _characterIdFor(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  return character ? character.characterId : null;
}

function _notify(actorId, message) {
  commands.sendNotification(actorId, message);
}

/** Translation of the return `code`s into player messages. */
const _ERROR_MESSAGES = Object.freeze({
  invalid_creator: 'Character not loaded.',
  invalid_actor: 'Character not loaded.',
  invalid_title: 'Invalid title (up to 96 characters).',
  invalid_reward: 'Invalid reward.',
  invalid_category: `Invalid category. Use: ${CATEGORIES.join(', ')}.`,
  invalid_description: 'Invalid description.',
  invalid_idempotency_key: 'Internal error, please try again.',
  invalid_expiry: 'Invalid deadline.',
  invalid_contract: 'Usage: provide the contract number.',
  contract_not_found: 'Contract not found.',
  invalid_status: 'This contract is not in that state right now.',
  creator_cannot_accept: 'You cannot accept your own contract.',
  not_the_worker: 'Only whoever accepted the contract can do that.',
  not_the_creator: 'Only the contract\'s creator can do that.',
  not_yet_expired: 'This contract has not expired yet.',
  not_expirable: 'This contract cannot expire right now.',
  review_window_open: 'The review window has not closed yet.',
  insufficient_funds: 'Not enough gold to lock the reward in escrow.'
});

function _reply(actorId, result, successMessage) {
  if (result.ok) {
    _notify(actorId, result.replayed ? 'Action already recorded.' : successMessage(result));
  } else {
    _notify(actorId, _ERROR_MESSAGES[result.code] || `Could not do that: ${result.code}`);
  }
  return result;
}

function _parseContractId(args) {
  const id = Number.parseInt(String(args || '').trim(), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function commandDefs() {
  return [
    {
      name: ['/contractcreate', '/contratocriar'],
      description: '[Contracts] Posts a contract, locking the reward in escrow',
      usage: '/contractcreate <category> <reward> <title>',
      handler: async (actorId, args) => {
        const creatorCharacterId = _characterIdFor(actorId);
        if (!creatorCharacterId) return _notify(actorId, 'Character not loaded.');

        const partes = String(args || '').trim().split(/\s+/);
        const category = partes[0];
        const reward = Number.parseInt(partes[1], 10);
        const title = partes.slice(2).join(' ');
        if (!category || !title || !Number.isFinite(reward)) {
          return _notify(actorId, 'Usage: /contractcreate <category> <reward> <title>');
        }

        const result = await create({ creatorCharacterId, title, category, reward, idempotencyKey: uuid() });
        return _reply(actorId, result, r => `Contract #${r.contractId} posted. ${r.reward} septims locked in escrow.`);
      }
    },
    {
      name: ['/contractaccept', '/contratoaceitar'],
      description: '[Contracts] Accepts an open contract',
      usage: '/contractaccept <id>',
      handler: async (actorId, args) => {
        const actorCharacterId = _characterIdFor(actorId);
        if (!actorCharacterId) return _notify(actorId, 'Character not loaded.');
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractaccept <id>');

        const result = await accept({ contractId, actorCharacterId, idempotencyKey: uuid() });
        return _reply(actorId, result, () => `Contract #${contractId} accepted.`);
      }
    },
    {
      name: ['/contractdeliver', '/contratoentregar'],
      description: '[Contracts] Declares delivery of an accepted contract',
      usage: '/contractdeliver <id>',
      handler: async (actorId, args) => {
        const actorCharacterId = _characterIdFor(actorId);
        if (!actorCharacterId) return _notify(actorId, 'Character not loaded.');
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractdeliver <id>');

        const result = await deliver({ contractId, actorCharacterId, idempotencyKey: uuid() });
        return _reply(actorId, result, () =>
          `Delivery of contract #${contractId} declared. The creator has ${Math.round(REVIEW_WINDOW_MS / 3_600_000)}h to review before automatic settlement.`
        );
      }
    },
    {
      name: ['/contractdispute', '/contratocontestar'],
      description: '[Contracts] Disputes a contract delivery (locks the escrow for staff review)',
      usage: '/contractdispute <id>',
      handler: async (actorId, args) => {
        const actorCharacterId = _characterIdFor(actorId);
        if (!actorCharacterId) return _notify(actorId, 'Character not loaded.');
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractdispute <id>');

        const result = await dispute({ contractId, actorCharacterId, idempotencyKey: uuid() });
        return _reply(actorId, result, () => `Contract #${contractId} disputed. Staff will review it — the escrow stays locked.`);
      }
    },
    {
      name: ['/contractsettle', '/contratoacertar'],
      description: '[Contracts] Releases the reward to the worker who delivered',
      usage: '/contractsettle <id>',
      handler: async (actorId, args) => {
        const actorCharacterId = _characterIdFor(actorId);
        if (!actorCharacterId) return _notify(actorId, 'Character not loaded.');
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractsettle <id>');

        const result = await settle({ contractId, actorCharacterId, idempotencyKey: uuid() });
        return _reply(actorId, result, () => `Contract #${contractId} settled.`);
      }
    },
    {
      name: ['/contractcancel', '/contratocancelar'],
      description: '[Contracts] Cancels a still-open contract and refunds the escrow',
      usage: '/contractcancel <id>',
      handler: async (actorId, args) => {
        const actorCharacterId = _characterIdFor(actorId);
        if (!actorCharacterId) return _notify(actorId, 'Character not loaded.');
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractcancel <id>');

        const result = await cancel({ contractId, actorCharacterId, idempotencyKey: uuid() });
        return _reply(actorId, result, () => `Contract #${contractId} cancelled. Escrow refunded.`);
      }
    },
    {
      name: ['/contracts', '/contratolistar'],
      description: '[Contracts] Lists open contracts',
      usage: '/contracts',
      handler: async (actorId) => {
        const abertos = await listOpen();
        if (abertos.length === 0) return _notify(actorId, 'No open contracts right now.');
        const linhas = abertos
          .slice(0, 10)
          .map(c => `#${c.id} [${c.category}] ${c.title} — ${c.reward} septims`)
          .join(' | ');
        return _notify(actorId, linhas);
      }
    },
    {
      name: ['/contractinfo', '/contratoinfo'],
      description: '[Contracts] Shows a contract\'s details',
      usage: '/contractinfo <id>',
      handler: async (actorId, args) => {
        const contractId = _parseContractId(args);
        if (!contractId) return _notify(actorId, 'Usage: /contractinfo <id>');
        const contrato = await getContract(contractId);
        if (!contrato) return _notify(actorId, 'Contract not found.');
        return _notify(
          actorId,
          `#${contrato.id} [${contrato.category}] ${contrato.title} — ${contrato.reward} septims — status: ${contrato.status}`
        );
      }
    }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic sweep — expiry and automatic settlement. Without this, `sweepExpired`
// and `sweepReviewed` are functions nobody calls: an expired contract would stay
// locked until some external code remembered to run the sweep by hand. Same
// pattern as `market-stalls-service._expirationTimer`.
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let _sweepTimer = null;

async function _sweepTick() {
  try {
    const expirados = await sweepExpired();
    const acertados = await sweepReviewed();
    const total = expirados.processed.length + acertados.processed.length;
    if (total > 0) {
      console.log(`[contracts] Varredura: ${expirados.processed.length} expirados, ${acertados.processed.length} acertados automaticamente.`);
    }
  } catch (err) {
    console.error('[contracts] Periodic sweep failed:', err.message);
  }
}

function initContractsService() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(_sweepTick, SWEEP_INTERVAL_MS);
}

function shutdownContractsService() {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

module.exports = {
  create, accept, deliver, dispute, settle, cancel, expire,
  sweepExpired, sweepReviewed,
  listOpen, getContract, history,
  STATUS, CATEGORIES, EXPIRABLE, REVIEW_WINDOW_MS,
  commandDefs, initContractsService, shutdownContractsService,
  // Exposed only for tests.
  SWEEP_INTERVAL_MS
};
