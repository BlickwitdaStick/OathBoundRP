/**
 * debt-service.js
 *
 * Debt as a **sealed, readable record**, never as automatic collection.
 *
 * ⚠️ PARKED: it is not registered in `core/module-registry.js` and does not run in
 * production. See `PARKED_SERVICES_DECISION.md` and Phase 0.
 *
 * Design: `docs/gameplay/DEBT_SYSTEM.md`
 * Decision: `docs/technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md` §2.8 and §4.4
 * Concept: Mereth Roleplay — no license and no public code; reimplemented
 * from the idea (`docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md` §4).
 *
 * ─── What this service does NOT do, and why ─────────────────────────────────
 *
 * It does **not** debit anyone by itself. It does not watch balances, does not seize incoming
 * gold, does not block actions, does not issue warrants, does not charge interest.
 *
 * The alternative — paying down the debt the moment the debtor receives gold —
 * was considered and rejected in ADR 004 §4.4. It removes the scene: nobody
 * needs to collect, so nobody collects, and the server becomes the loan shark instead of the
 * other player. Default needs to be **RP material** for guilds,
 * courts and crime (briefing §11), not moderation work.
 *
 * What the service guarantees is the opposite: that the debt exists in a way anyone
 * can read, that payment moves real septims through `economy-service`,
 * and that `remaining` only drops because a payment or forgiveness was recorded.
 *
 * ─── States ─────────────────────────────────────────────────────────────────
 *
 *   active ──► paid       (remaining reached zero through payment)
 *          ──► forgiven   (the creditor gave up the remaining balance)
 *          ──► defaulted  (declared in default — it is a LABEL, not a seizure)
 *
 * `defaulted` moves no money and is not terminal for payment: a debt
 * marked as in default can still be paid off, and going back to `active` is a
 * consequence of paying, not a separate transition.
 */

const database = require('./database');
const economyService = require('./core/economy-service');

const MODULE = 'debt';

const STATUS = Object.freeze({
  ACTIVE: 'active',
  PAID: 'paid',
  DEFAULTED: 'defaulted',
  FORGIVEN: 'forgiven'
});

/** States in which payment is still possible. `paid` and `forgiven` are closed. */
const PAYABLE = Object.freeze([STATUS.ACTIVE, STATUS.DEFAULTED]);

const ORIGINS = Object.freeze(['fine', 'contract', 'rent', 'tax', 'manual']);

function positiveId(value) {
  const id = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
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

async function _lockDebt(conn, debtId) {
  const [rows] = await conn.query(
    `SELECT id, debtor_character_id, creditor_type, creditor_ref,
            principal, remaining, status
       FROM debts WHERE id = ? FOR UPDATE`,
    [debtId]
  );
  return rows[0] || null;
}

async function _findPaymentReplay(conn, idempotencyKey) {
  const [rows] = await conn.query(
    'SELECT id, debt_id, amount, kind FROM debt_payments WHERE idempotency_key = ? FOR UPDATE',
    [idempotencyKey]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Abertura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a debt. It moves no money — a debt is the record that the
 * money **did not** move.
 *
 * `idempotencyKey` is mandatory and UNIQUE because the typical source is a
 * repeatable event: the same fine resent must not become two debts.
 *
 * @param {object} request
 * @param {number} request.debtorCharacterId
 * @param {{type:string, ref:string|number}} request.creditor
 * @param {number} request.amount
 * @param {string} request.reason
 * @param {string} [request.originType] fine, contract, rent, tax, manual
 * @param {string|number} [request.originRef]
 * @param {string} request.idempotencyKey
 */
async function open(request, dependencies = {}) {
  const economy = dependencies.economy || economyService;
  const debtorCharacterId = positiveId(request?.debtorCharacterId);
  const creditor = economy.normalizeAccount(request?.creditor);
  const amount = economy.normalizeAmount(request?.amount);
  const reason = normalizeText(request?.reason, 255);
  const idempotencyKey = economy.normalizeIdempotencyKey(request?.idempotencyKey);
  const originType = request?.originType === undefined ? 'manual' : request.originType;
  const originRef = request?.originRef === undefined || request.originRef === null
    ? null
    : String(request.originRef);

  if (!debtorCharacterId) return { ok: false, code: 'invalid_debtor' };
  if (!creditor || creditor.type === economy.SYSTEM_TYPE) return { ok: false, code: 'invalid_creditor' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!ORIGINS.includes(originType)) return { ok: false, code: 'invalid_origin' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };
  // Owing yourself is not a debt, it is a calculation error by the caller.
  if (creditor.type === 'character' && Number(creditor.ref) === debtorCharacterId) {
    return { ok: false, code: 'self_debt' };
  }

  const escrever = async conn => {
    const [existing] = await conn.query(
      'SELECT id, remaining, status FROM debts WHERE idempotency_key = ? FOR UPDATE',
      [idempotencyKey]
    );
    if (existing[0]) {
      return { ok: true, replayed: true, debtId: existing[0].id, remaining: Number(existing[0].remaining) };
    }

    const [insert] = await conn.query(
      `INSERT INTO debts
        (debtor_character_id, creditor_type, creditor_ref, principal, remaining,
         reason, origin_type, origin_ref, status, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [debtorCharacterId, creditor.type, creditor.ref, amount, amount,
        reason, originType, originRef, STATUS.ACTIVE, idempotencyKey]
    );

    return { ok: true, replayed: false, debtId: insert.insertId, remaining: amount };
  };

  // The variant inside the caller's transaction exists for a concrete case: the guard's
  // fine has to write the charge, the `fines` row and the debt **together**.
  // Opening its own transaction here would let a crash in the middle leave a fine
  // without the debt it originated — which is the unfixed half of Finding 8.
  return dependencies.conn ? escrever(dependencies.conn) : _withTransaction(dependencies, escrever);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pays a debt, fully or partially.
 *
 * The septims move **first**, through `economy-service`, and `remaining` only drops
 * afterwards — in the same transaction. The order is the point: if the reduction came first,
 * a payment failure would leave the debt smaller without anyone having received anything,
 * which is the same class as the fine bug (`ECONOMY_FRAMEWORK_AUDIT.md` Finding 8).
 *
 * Partial payment is allowed on purpose — "the worker receives what
 * exists; the rest stays on record" is the behavior that turns
 * default into a scene instead of a block.
 */
async function pay(request, dependencies = {}) {
  const economy = dependencies.economy || economyService;
  const debtId = positiveId(request?.debtId);
  const amount = economy.normalizeAmount(request?.amount);
  const idempotencyKey = economy.normalizeIdempotencyKey(request?.idempotencyKey);
  const actorCharacterId = request?.actorCharacterId === undefined
    ? null
    : positiveId(request.actorCharacterId);

  if (!debtId) return { ok: false, code: 'invalid_debt' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  return _withTransaction(dependencies, async conn => {
    const debt = await _lockDebt(conn, debtId);
    if (!debt) return { ok: false, code: 'debt_not_found' };

    const prior = await _findPaymentReplay(conn, idempotencyKey);
    if (prior) {
      return { ok: true, replayed: true, debtId, paid: Number(prior.amount), remaining: Number(debt.remaining) };
    }

    if (!PAYABLE.includes(debt.status)) {
      return { ok: false, code: 'debt_closed', status: debt.status };
    }
    const remaining = Number(debt.remaining);
    // Paying more than owed is not generosity, it is a UI error: the surplus
    // would have nowhere to be recorded and the debt would end up with a negative `remaining`,
    // which the DB's CHECK would refuse anyway.
    if (amount > remaining) return { ok: false, code: 'amount_exceeds_remaining', remaining };

    const moved = await economy.transferInTransaction(conn, {
      from: { type: 'character', ref: debt.debtor_character_id },
      to: { type: debt.creditor_type, ref: debt.creditor_ref },
      amount,
      reason: 'debt_payment',
      module: MODULE,
      actorCharacterId: actorCharacterId || debt.debtor_character_id,
      idempotencyKey: `${idempotencyKey}~pay`
    }, dependencies);
    if (!moved.ok) return moved;

    return _applyReduction(conn, {
      debt, amount, remaining, idempotencyKey, actorCharacterId,
      kind: 'payment', transferId: moved.transferId,
      closedStatus: STATUS.PAID
    });
  });
}

/**
 * Forgives part or all of the balance. No septim moves — the creditor gives it up.
 *
 * Only the creditor can forgive, and when the creditor is institutional (city, faction)
 * the caller has already resolved authorization: this file does not know who rules a
 * city, and duplicating that rule here would create two places to maintain it.
 */
async function forgive(request, dependencies = {}) {
  const economy = dependencies.economy || economyService;
  const debtId = positiveId(request?.debtId);
  const idempotencyKey = economy.normalizeIdempotencyKey(request?.idempotencyKey);
  const actorCharacterId = request?.actorCharacterId === undefined
    ? null
    : positiveId(request.actorCharacterId);

  if (!debtId) return { ok: false, code: 'invalid_debt' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  return _withTransaction(dependencies, async conn => {
    const debt = await _lockDebt(conn, debtId);
    if (!debt) return { ok: false, code: 'debt_not_found' };

    const prior = await _findPaymentReplay(conn, idempotencyKey);
    if (prior) return { ok: true, replayed: true, debtId, remaining: Number(debt.remaining) };

    if (!PAYABLE.includes(debt.status)) return { ok: false, code: 'debt_closed', status: debt.status };

    const remaining = Number(debt.remaining);
    const amount = economy.normalizeAmount(request?.amount) || remaining;
    if (amount > remaining) return { ok: false, code: 'amount_exceeds_remaining', remaining };

    return _applyReduction(conn, {
      debt, amount, remaining, idempotencyKey, actorCharacterId,
      kind: 'forgiveness', transferId: null,
      closedStatus: STATUS.FORGIVEN
    });
  });
}

/**
 * Records the payment and closes the debt if it reached zero.
 *
 * `remaining = remaining - ?` under the lock, with `AND remaining >= ?`: same
 * pattern as the balance debit. The guard in the `WHERE` is redundant with the check
 * done above, and it exists so that a future path that forgets the check
 * gets `affectedRows = 0` instead of writing a negative debt.
 */
async function _applyReduction(conn, params) {
  const restante = params.remaining - params.amount;

  const [update] = await conn.query(
    `UPDATE debts SET remaining = remaining - ?, status = ?, closed_at = ?
      WHERE id = ? AND remaining >= ?`,
    [
      params.amount,
      restante === 0 ? params.closedStatus : params.debt.status,
      restante === 0 ? new Date() : null,
      params.debt.id,
      params.amount
    ]
  );
  if (update.affectedRows !== 1) {
    throw new Error(`[debt] payment refused for debt ${params.debt.id}`);
  }

  await conn.query(
    `INSERT INTO debt_payments (debt_id, amount, transfer_id, kind, actor_character_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [params.debt.id, params.amount, params.transferId, params.kind,
      params.actorCharacterId, params.idempotencyKey]
  );

  return {
    ok: true, replayed: false,
    debtId: params.debt.id,
    paid: params.amount,
    remaining: restante,
    status: restante === 0 ? params.closedStatus : params.debt.status,
    transferId: params.transferId
  };
}

/**
 * Marks default. **A label, not a seizure**: no septim moves, no
 * item is taken, no player action is blocked. What changes is that the
 * debt starts showing up as `defaulted` to whoever looks it up — and what is done
 * with that information is the job of guilds, courts and players.
 */
async function markDefaulted(request, dependencies = {}) {
  const debtId = positiveId(request?.debtId);
  if (!debtId) return { ok: false, code: 'invalid_debt' };

  return _withTransaction(dependencies, async conn => {
    const debt = await _lockDebt(conn, debtId);
    if (!debt) return { ok: false, code: 'debt_not_found' };
    if (debt.status !== STATUS.ACTIVE) return { ok: false, code: 'invalid_status', status: debt.status };

    await conn.query('UPDATE debts SET status = ? WHERE id = ? AND status = ?',
      [STATUS.DEFAULTED, debtId, STATUS.ACTIVE]);
    return { ok: true, debtId, status: STATUS.DEFAULTED };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading — the part that makes debt "readable by any player"
// ─────────────────────────────────────────────────────────────────────────────

async function listByDebtor(debtorCharacterId, dependencies = {}) {
  const db = dependencies.db || database;
  const id = positiveId(debtorCharacterId);
  if (!id) return [];
  return db.query(
    `SELECT id, creditor_type, creditor_ref, principal, remaining, reason,
            origin_type, origin_ref, status, created_at
       FROM debts WHERE debtor_character_id = ? AND status IN (?, ?)
      ORDER BY created_at`,
    [id, STATUS.ACTIVE, STATUS.DEFAULTED]
  );
}

async function listByCreditor(creditor, dependencies = {}) {
  const economy = dependencies.economy || economyService;
  const db = dependencies.db || database;
  const account = economy.normalizeAccount(creditor);
  if (!account) return [];
  return db.query(
    `SELECT id, debtor_character_id, principal, remaining, reason, status, created_at
       FROM debts WHERE creditor_type = ? AND creditor_ref = ? AND status IN (?, ?)
      ORDER BY created_at`,
    [account.type, account.ref, STATUS.ACTIVE, STATUS.DEFAULTED]
  );
}

async function history(debtId, dependencies = {}) {
  const db = dependencies.db || database;
  const id = positiveId(debtId);
  if (!id) return [];
  return db.query(
    'SELECT amount, kind, transfer_id, actor_character_id, created_at FROM debt_payments WHERE debt_id = ? ORDER BY id',
    [id]
  );
}

module.exports = {
  open, pay, forgive, markDefaulted,
  listByDebtor, listByCreditor, history,
  STATUS, PAYABLE, ORIGINS
};
