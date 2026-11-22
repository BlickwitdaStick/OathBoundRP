/**
 * core/economy-service.js
 *
 * The single door for money. Every septim that changes holder goes through here.
 *
 * ─── How this relates to transaction-service ───────────────────────────────
 *
 * `core/transaction-service.js` is still the **engine** of
 * `characters.gold` — it is the only file that writes that column, and nothing
 * here undoes that. What changes is who sits on top:
 *
 *     domain module  →  economy-service  →  transaction-service.tx.*
 *                                        →  treasuries (cities/holds/...)
 *                                        →  economy_escrow
 *
 * A domain module (governance, stall, contract, rent) calls **this**
 * file. Calling `tx.applyGoldDelta` directly still works and is still
 * wrong: those are the engine's primitives, not the economy's API.
 *
 * ─── What this file solves ─────────────────────────────────────────────────
 *
 * Decision: `docs/technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md`
 * Evidence: `docs/research/ECONOMY_FRAMEWORK_AUDIT.md`
 *
 *   Finding 1  — the ledger now names both sides, with `transfer_id`.
 *   Finding 2  — the treasury stops being a loose `UPDATE` and gets a ledger.
 *   Finding 7  — typed result: a refusal is `{ok:false, code}`, an
 *                infrastructure failure **throws**. `false` never again means three
 *                things.
 *   Finding 10 — locks in canonical order, not in "payer, payee" order.
 *   Finding 11 — `escrow` is a real holder, able to hold value.
 *
 * ─── An account is a reference, not a balance row ─────────────────────────
 *
 * `{ type, ref }`. The service resolves the pair to where the balance really lives —
 * there is no `accounts` table duplicating value that already exists (ADR 004 §2.1 and
 * the rejected alternative §4.1).
 */

const crypto = require('crypto');
const database = require('../database');
const transactionService = require('./transaction-service');
const serverOptions = require('./server-options');

const MODULE_DEFAULT = 'economy';

/**
 * Where the balance of each holder type really lives.
 *
 * ─── Why it is a closed list ───────────────────────────────────────────────
 *
 * `_lockBalance` and `_applyDelta` interpolate table and column names into the SQL —
 * a `?` does not work for identifiers. The closed list is what makes that
 * interpolation safe by construction: no name coming from a payload,
 * configuration or module reaches the SQL. A new holder comes in by editing this
 * object, under review. Same criterion as transaction-service's `STACK_TABLES`.
 */
const ACCOUNT_KINDS = Object.freeze({
  character: Object.freeze({ table: 'characters', keyColumn: 'id', balanceColumn: 'gold', numericRef: true }),
  city: Object.freeze({ table: 'cities', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  hold: Object.freeze({ table: 'holds', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  faction: Object.freeze({ table: 'factions', keyColumn: 'id', balanceColumn: 'treasury', numericRef: true }),
  realm: Object.freeze({ table: 'realms', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  escrow: Object.freeze({ table: 'economy_escrow', keyColumn: 'escrow_id', balanceColumn: 'balance', numericRef: false })
});

/**
 * `system` is the declared boundary through which gold enters and leaves the world:
 * whitelist starting gold, death penalty, staff adjustment, sale to an NPC.
 *
 * It **has no balance** on purpose — there is no column, and the `SUM(delta)` of
 * `system` matches nothing. What it gives is the complete list of septim
 * creation and destruction, which is what was missing: today the death penalty
 * destroys wealth with no counterpart, and an undeclared drain is
 * indistinguishable from gold vanishing because of a bug (audit §9).
 */
const SYSTEM_TYPE = 'system';

const MAX_AMOUNT = transactionService.tx.MAX_GOLD;

const ESCROW_PURPOSES = Object.freeze(['contract', 'auction', 'rent_deposit', 'wager']);

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Input normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accepts `{ type, ref }` and returns the canonical shape, or `null` if invalid.
 * `ref` always becomes a string — that is how it is written in the ledger, and comparing
 * `7` with `'7'` in two different places is how one holder becomes two.
 */
function normalizeAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  if (type === SYSTEM_TYPE) {
    const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
    // The `system` label is mandatory and goes into the ledger: `system:mint`
    // says nothing, `system:whitelist_grant` says where the gold came from.
    if (!/^[a-z0-9_]{3,48}$/.test(ref)) return null;
    return { type, ref };
  }
  const kind = ACCOUNT_KINDS[type];
  if (!kind) return null;
  if (kind.numericRef) {
    const ref = typeof value.ref === 'string' ? Number(value.ref) : value.ref;
    if (!Number.isSafeInteger(ref) || ref <= 0) return null;
    return { type, ref: String(ref) };
  }
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  if (ref.length === 0 || ref.length > 64) return null;
  return { type, ref };
}

function normalizeAmount(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return amount;
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null) return uuid();
  if (typeof value !== 'string') return null;
  const key = value.trim();
  // The cap leaves room for the credit leg's `#in` suffix within the
  // VARCHAR(128) of `gold_transactions.idempotency_key`.
  return key.length >= 8 && key.length <= 96 ? key : null;
}

function normalizeReason(value) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 && reason.length <= 64 ? reason : null;
}

/** Canonical ordering key for the locks — see `_lockPair`. */
function lockKey(account) {
  return `${account.type}:${account.ref}`;
}

function sameAccount(a, b) {
  return a.type === b.type && a.ref === b.ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saldo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads and locks an account's balance inside the caller's transaction.
 *
 * @returns {Promise<{found:boolean, balance:number|null}>} `balance` is `null`
 *          for `system`, which has no balance by definition.
 */
async function _lockBalance(conn, account) {
  if (account.type === SYSTEM_TYPE) return { found: true, balance: null };
  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  const [rows] = await conn.query(
    `SELECT ${kind.balanceColumn} AS balance FROM ${kind.table} WHERE ${kind.keyColumn} = ? FOR UPDATE`,
    [ref]
  );
  if (rows.length === 0) return { found: false, balance: null };
  return { found: true, balance: Number(rows[0].balance) };
}

/**
 * Locks both accounts of a transfer in **canonical order**.
 *
 * Finding 10: `buyItem` and `transfer()` locked in "payer, payee" order.
 * Character 7 buying from character 12's stall while 12 buys from 7's
 * stall produces `7→12` in one transaction and `12→7` in the other: an InnoDB deadlock, which the
 * detector resolves by killing one — and the player reads "could not complete the
 * purchase" for a reason that has nothing to do with them.
 *
 * Ordering by `type:ref` makes both transactions ask for the locks in the same
 * order, and the second waits instead of crossing.
 */
async function _lockPair(conn, from, to) {
  const ordered = [from, to].sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : 1));
  const balances = new Map();
  for (const account of ordered) {
    balances.set(lockKey(account), await _lockBalance(conn, account));
  }
  return balances;
}

/**
 * Applies the delta to the balance. It does not write the ledger — the caller is responsible for
 * both, and the separation exists because the two legs share `transfer_id`.
 */
async function _applyDelta(conn, account, delta, dependencies) {
  if (account.type === SYSTEM_TYPE) return;

  if (account.type === 'character') {
    // `characters.gold` still has a single door, and it is not this one.
    const tx = dependencies.tx || transactionService.tx;
    await tx.applyGoldDelta(conn, Number(account.ref), delta);
    return;
  }

  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  // The `>= 0` guard in the UPDATE itself is redundant with the check done under the
  // lock — and that is on purpose. If someone adds a path that skips the
  // check, the DB refuses instead of writing a negative treasury.
  const [result] = await conn.query(
    `UPDATE ${kind.table} SET ${kind.balanceColumn} = ${kind.balanceColumn} + ?
      WHERE ${kind.keyColumn} = ? AND ${kind.balanceColumn} + ? >= 0`,
    [delta, ref, delta]
  );
  if (result.affectedRows !== 1) {
    throw new Error(`[economy] balance of ${lockKey(account)} refused delta ${delta}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes the two legs of a transfer.
 *
 * The raw key always goes on the **debit** leg — it is the one
 * `_findReplay` looks up. The credit leg gets `#in`, because the `UNIQUE` on
 * `idempotency_key` does not accept both being equal.
 *
 * That fixes Finding 5: transaction-service's `transfer()` looked up the
 * raw key and only wrote derived keys (`_item_from`, `_gold_to`), so its
 * check never matched anything — it was dead code, and what prevented
 * duplication was the DB's `UNIQUE`, at the price of the caller receiving `false`
 * for an operation that had succeeded.
 */
async function _recordLegs(conn, params, dependencies) {
  const tx = dependencies.tx || transactionService.tx;
  const common = {
    delta: 0,
    reason: params.reason,
    module: params.module,
    transferId: params.transferId,
    actorCharacterId: params.actorCharacterId
  };

  await tx.recordGoldLedger(conn, {
    ...common,
    delta: -params.amount,
    characterId: params.from.type === 'character' ? Number(params.from.ref) : null,
    ownerType: params.from.type,
    ownerRef: params.from.ref,
    counterpartyType: params.to.type,
    counterpartyRef: params.to.ref,
    idempotencyKey: params.idempotencyKey
  });

  await tx.recordGoldLedger(conn, {
    ...common,
    delta: params.amount,
    characterId: params.to.type === 'character' ? Number(params.to.ref) : null,
    ownerType: params.to.type,
    ownerRef: params.to.ref,
    counterpartyType: params.from.type,
    counterpartyRef: params.from.ref,
    idempotencyKey: `${params.idempotencyKey}#in`
  });
}

/**
 * Records a large transfer in `audit_logs` — the same place
 * `admin-service.auditLog` writes to, so staff can look at money and staff
 * actions in one place. It does not create a new table: `gold_transactions` already has the
 * full history (Finding 1); what was missing was flagging whatever crosses a
 * configurable threshold (`economy.largeTransactionThreshold`) in a place auditing
 * already routinely looks at, without having to sum the ledger every time.
 *
 * Writes on the SAME `conn`/transaction as the movement — atomic with the ledger, with no
 * window between "moved money" and "recorded that it moved a lot of money". But the
 * `INSERT` itself never propagates errors: a failure here must not roll back a
 * valid money transfer, same philosophy as `_applyToClient` in
 * `transaction-service.js` ("the DB is already correct, the rest is best-effort").
 *
 * @param {object} conn connection with an active transaction
 * @param {object} params
 * @param {object} [dependencies]
 */
async function _auditLargeTransfer(conn, params, dependencies = {}) {
  const so = dependencies.serverOptions || serverOptions;
  const logger = dependencies.logger || console;
  const threshold = so.get('economy.largeTransactionThreshold');
  if (params.amount < threshold) return;

  try {
    await conn.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'economy:large_transfer',
        null,
        null,
        JSON.stringify({
          from: params.from, to: params.to, amount: params.amount,
          transferId: params.transferId, reason: params.reason,
          module: params.module, actorCharacterId: params.actorCharacterId || null
        })
      ]
    );
  } catch (err) {
    logger.error(`[economy] Failed to write audit_logs for large transfer ${params.transferId} (transfer already applied, only the audit failed): ${err.message}`);
  }
}

/**
 * Looks for a movement already written with this key, **inside** the transaction.
 *
 * Finding 6: transaction-service's public functions check
 * idempotency on a pool connection and only then open the transaction. Two
 * concurrent calls read nothing, both proceed, and the `UNIQUE` knocks down the
 * second — correct result, wrong message. Here the read happens under the
 * same transaction and with `FOR UPDATE`, so the second call **waits** and
 * sees the first. It is the pattern `market-stalls`, `regional-market` and
 * `institutional-treasury` already use.
 */
async function _findReplay(conn, idempotencyKey) {
  const [rows] = await conn.query(
    `SELECT transfer_id, delta, owner_type, owner_ref, counterparty_type, counterparty_ref
       FROM gold_transactions WHERE idempotency_key = ? FOR UPDATE`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

function replayResult(row) {
  return {
    ok: true,
    replayed: true,
    transferId: row.transfer_id,
    amount: Math.abs(Number(row.delta))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Moves septims from one account to another, **inside the caller's transaction**.
 *
 * ─── Contract ──────────────────────────────────────────────────────────────
 *
 * - The caller opens, commits and rolls back. This function does none of the three.
 * - A rule refusal returns `{ok:false, code}` **having written nothing** — only
 *   locks were taken, so committing or rolling back is safe.
 * - An infrastructure failure **throws**. It does not become `ok:false`, and that is the
 *   distinction Finding 7 exists to restore: today a DB timeout
 *   becomes an unpaid fine and an arrest warrant in `governance-service`.
 *
 * @param {object} conn connection with an active transaction
 * @param {object} request
 * @param {{type:string, ref:string|number}} request.from
 * @param {{type:string, ref:string|number}} request.to
 * @param {number|string} request.amount
 * @param {string} request.reason
 * @param {string} [request.module]
 * @param {number} [request.actorCharacterId] who asked for the movement, when it is not the holder
 * @param {string} [request.idempotencyKey]
 */
async function transferInTransaction(conn, request, dependencies = {}) {
  const from = normalizeAccount(request?.from);
  const to = normalizeAccount(request?.to);
  const amount = normalizeAmount(request?.amount);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);

  if (!from) return { ok: false, code: 'invalid_from_account' };
  if (!to) return { ok: false, code: 'invalid_to_account' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };
  // Transferring to yourself writes two rows that cancel out and a `transfer_id`
  // that tells no story at all. It is always a calculation error by the caller.
  if (sameAccount(from, to)) return { ok: false, code: 'same_account' };
  // Gold being born and dying on the same row is not a transfer.
  if (from.type === SYSTEM_TYPE && to.type === SYSTEM_TYPE) return { ok: false, code: 'system_to_system' };

  const prior = await _findReplay(conn, idempotencyKey);
  if (prior) return replayResult(prior);

  const balances = await _lockPair(conn, from, to);
  const origem = balances.get(lockKey(from));
  const destino = balances.get(lockKey(to));

  if (!origem.found) return { ok: false, code: 'from_account_not_found' };
  if (!destino.found) return { ok: false, code: 'to_account_not_found' };
  if (origem.balance !== null && origem.balance < amount) {
    return { ok: false, code: 'insufficient_funds', balance: origem.balance };
  }
  if (destino.balance !== null && destino.balance + amount > MAX_AMOUNT) {
    return { ok: false, code: 'balance_overflow', balance: destino.balance };
  }

  const transferId = uuid();
  await _applyDelta(conn, from, -amount, dependencies);
  await _applyDelta(conn, to, amount, dependencies);
  await _recordLegs(conn, {
    from, to, amount, transferId, idempotencyKey,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId
  }, dependencies);
  await _auditLargeTransfer(conn, {
    from, to, amount, transferId, reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId
  }, dependencies);

  return { ok: true, replayed: false, transferId, amount };
}

/**
 * Moves septims opening its own transaction. Use it when the operation is isolated;
 * use `transferInTransaction` when it must commit together with something else
 * (stall purchase, contract settlement).
 */
async function transfer(request, dependencies = {}) {
  const db = dependencies.db || database;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const result = await transferInTransaction(conn, request, dependencies);
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

async function _safeRollback(conn) {
  try { await conn.rollback(); } catch { /* keep the original error */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locks a holder's value in an escrow account.
 *
 * ─── Locked at posting, not at delivery ────────────────────────────────────
 *
 * The value leaves the promiser's pocket **at the moment of the promise**. A failure
 * here yields **no escrow and no contract**, never a contract nobody can
 * pay. It is the same fail-closed philosophy as `server-options`, and it is the concept
 * Mereth describes (see `SKYMP_ECOSYSTEM_DEEP_DIVE.md` §4 — no license and
 * no public code: only the idea was used).
 */
async function openEscrowInTransaction(conn, request, dependencies = {}) {
  const funder = normalizeAccount(request?.funder);
  const amount = normalizeAmount(request?.amount);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);
  const purpose = typeof request?.purpose === 'string' ? request.purpose.trim() : '';

  if (!funder || funder.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_funder' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };
  if (!ESCROW_PURPOSES.includes(purpose)) return { ok: false, code: 'invalid_purpose' };

  const [existingRows] = await conn.query(
    'SELECT escrow_id, balance, status FROM economy_escrow WHERE idempotency_key = ? FOR UPDATE',
    [idempotencyKey]
  );
  if (existingRows[0]) {
    return {
      ok: true, replayed: true,
      escrowId: existingRows[0].escrow_id,
      amount: Number(existingRows[0].balance)
    };
  }

  // The escrow account is born with a zero balance and is credited by the transfer —
  // that way the locked value has the same two ledger legs as any
  // other movement, instead of appearing through an `INSERT`.
  const escrowId = uuid();
  await conn.query(
    `INSERT INTO economy_escrow (escrow_id, purpose, funder_type, funder_ref, balance, status, idempotency_key)
     VALUES (?, ?, ?, ?, 0, 'held', ?)`,
    [escrowId, purpose, funder.type, funder.ref, idempotencyKey]
  );

  const moved = await transferInTransaction(conn, {
    from: funder,
    to: { type: 'escrow', ref: escrowId },
    amount,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId,
    idempotencyKey: `${idempotencyKey}~fund`
  }, dependencies);

  if (!moved.ok) return moved;
  return { ok: true, replayed: false, escrowId, amount, transferId: moved.transferId };
}

/**
 * Releases the escrow to a beneficiary and closes it.
 *
 * `status` becomes `released` (or `refunded`, when the beneficiary is the
 * funder themselves). The transition only happens from `held` — releasing twice
 * is the obvious escrow exploit, and the `FOR UPDATE` plus the status check
 * close it within the same transaction.
 */
async function closeEscrowInTransaction(conn, request, dependencies = {}) {
  const beneficiary = normalizeAccount(request?.beneficiary);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);
  const escrowId = typeof request?.escrowId === 'string' ? request.escrowId.trim() : '';

  if (!escrowId) return { ok: false, code: 'invalid_escrow' };
  if (!beneficiary || beneficiary.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_beneficiary' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  const [rows] = await conn.query(
    'SELECT escrow_id, funder_type, funder_ref, balance, status FROM economy_escrow WHERE escrow_id = ? FOR UPDATE',
    [escrowId]
  );
  const escrow = rows[0];
  if (!escrow) return { ok: false, code: 'escrow_not_found' };

  // ─── Replay before status ─────────────────────────────────────────────────
  //
  // The order matters and the reverse is a bug: an already released escrow has
  // `status = 'released'`, so checking the status first would make a **legitimate
  // retry** (same key, resent because of a network timeout) receive
  // `escrow_not_held` — Finding 7 reborn inside its own fix. The
  // ledger is what knows whether this key already moved money; the status only knows that
  // *some* release happened.
  const prior = await _findReplay(conn, idempotencyKey);
  if (prior) {
    return {
      ...replayResult(prior),
      escrowId,
      outcome: escrow.status === 'refunded' ? 'refunded' : 'released'
    };
  }

  if (escrow.status !== 'held') {
    return { ok: false, code: 'escrow_not_held', status: escrow.status };
  }

  const amount = Number(escrow.balance);
  if (amount <= 0) return { ok: false, code: 'escrow_empty' };

  const moved = await transferInTransaction(conn, {
    from: { type: 'escrow', ref: escrowId },
    to: beneficiary,
    amount,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId,
    idempotencyKey
  }, dependencies);
  if (!moved.ok) return moved;

  const devolvido = beneficiary.type === escrow.funder_type && beneficiary.ref === String(escrow.funder_ref);
  await conn.query(
    'UPDATE economy_escrow SET status = ? WHERE escrow_id = ? AND status = ?',
    [devolvido ? 'refunded' : 'released', escrowId, 'held']
  );

  return {
    ok: true,
    replayed: moved.replayed,
    escrowId,
    amount,
    transferId: moved.transferId,
    outcome: devolvido ? 'refunded' : 'released'
  };
}

async function openEscrow(request, dependencies = {}) {
  return _withTransaction(dependencies, conn => openEscrowInTransaction(conn, request, dependencies));
}

async function closeEscrow(request, dependencies = {}) {
  return _withTransaction(dependencies, conn => closeEscrowInTransaction(conn, request, dependencies));
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

// ─────────────────────────────────────────────────────────────────────────────
// Staff adjustment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `economy.adjust` from briefing §12: staff create or destroy septims against
 * `system`, with a mandatory reason and actor.
 *
 * **This file does not check permissions.** The caller already knows who the staff member is and with
 * which role — duplicating the check here would create two places to keep it
 * up to date. What this file guarantees is that the adjustment is **impossible to make without a
 * trail**: `actorCharacterId` and `reason` are mandatory, and the other side of the
 * movement is always `system:staff_adjust`, so a `SELECT` on the ledger lists
 * all the gold staff created or destroyed.
 */
async function adjust(request, dependencies = {}) {
  const target = normalizeAccount(request?.target);
  const amount = normalizeAmount(Math.abs(Number(request?.amount)));
  const reason = normalizeReason(request?.reason);
  const actorCharacterId = request?.actorCharacterId;
  const direction = Number(request?.amount) >= 0 ? 'credit' : 'debit';

  if (!target || target.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_target' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!Number.isSafeInteger(actorCharacterId) || actorCharacterId <= 0) {
    return { ok: false, code: 'invalid_actor' };
  }

  const systemAccount = { type: SYSTEM_TYPE, ref: 'staff_adjust' };
  return transfer({
    from: direction === 'credit' ? systemAccount : target,
    to: direction === 'credit' ? target : systemAccount,
    amount,
    reason,
    module: request.module || 'admin',
    actorCharacterId,
    idempotencyKey: request.idempotencyKey
  }, dependencies);
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

async function getBalance(accountRequest, dependencies = {}) {
  const account = normalizeAccount(accountRequest);
  if (!account) return { ok: false, code: 'invalid_account' };
  if (account.type === SYSTEM_TYPE) return { ok: false, code: 'system_has_no_balance' };
  const db = dependencies.db || database;
  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  const rows = await db.query(
    `SELECT ${kind.balanceColumn} AS balance FROM ${kind.table} WHERE ${kind.keyColumn} = ?`,
    [ref]
  );
  if (rows.length === 0) return { ok: false, code: 'account_not_found' };
  return { ok: true, account, balance: Number(rows[0].balance) };
}

/**
 * Checks the stored balance against the sum of the ledger's deltas.
 *
 * This is what briefing §3 means by "a balance can be a snapshot, the ledger
 * is history" — and it is what is **impossible** today for treasuries, because tax
 * comes in through a loose `UPDATE` and leaves no row (Finding 2).
 *
 * It is only conclusive for accounts whose balance was born after migration v15.
 * `characters.gold` has history from before the ledger and will diverge by
 * construction — that is why `ledgerSum` is returned along with it, and not just the verdict.
 */
async function reconcile(accountRequest, dependencies = {}) {
  const balance = await getBalance(accountRequest, dependencies);
  if (!balance.ok) return balance;
  const db = dependencies.db || database;
  const rows = await db.query(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM gold_transactions WHERE owner_type = ? AND owner_ref = ?',
    [balance.account.type, balance.account.ref]
  );
  const ledgerSum = Number(rows[0]?.total || 0);
  return {
    ok: true,
    account: balance.account,
    balance: balance.balance,
    ledgerSum,
    matches: ledgerSum === balance.balance
  };
}

module.exports = {
  transfer,
  transferInTransaction,
  openEscrow,
  openEscrowInTransaction,
  closeEscrow,
  closeEscrowInTransaction,
  adjust,
  getBalance,
  reconcile,

  // Exposed for the domain services (contracts, debt) and for tests.
  normalizeAccount,
  normalizeAmount,
  normalizeIdempotencyKey,
  ACCOUNT_KINDS,
  ESCROW_PURPOSES,
  SYSTEM_TYPE,
  MAX_AMOUNT
};
