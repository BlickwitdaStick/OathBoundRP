/**
 * core/inventory.js — the central item-movement API
 *
 * **No gameplay module writes to an inventory table.** Items move
 * through `inventory.transfer()`, which validates, locks, moves both ends and writes the
 * ledger in a single transaction.
 *
 * ─── The problem this solves ────────────────────────────────────────────────
 *
 * `core/transaction-service.js` is good and does what it promises — but it can only talk
 * about **one** owner: a character. Every time an item had to go somewhere else,
 * whoever needed it wrote the other side by hand:
 *
 *   - `housing-service.depositItem` — `removeItem()` (its own transaction, already
 *     committed) followed by two loose `db.query` calls on the container. If the second
 *     one fails, the item **vanished**.
 *   - `market-stalls.addItem` — `removeItem()` committed, then a second
 *     transaction for the listing, with a compensating `giveItem()` in the `catch`.
 *     Compensation only covers failures this process gets to observe.
 *   - `market-stalls.packStall` — returns N items in N independent
 *     transactions, with all N already marked `removed`.
 *
 * All three have the shape of `economy-service.transfer` (`removeGold` followed by
 * `addGold`, no transaction), which was deleted on 2026-08-06, and the shape of the
 * pre-Phase-3 `craftItem`. It is not a coincidence: it is what happens when the API only
 * knows how to talk about one side. Full diagnosis in
 * `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §2 to §5.
 *
 * ─── What this file does NOT do, and why ────────────────────────────────────
 *
 * - **It does not measure distance.** That is the interaction pipeline's job
 *   (`core/interaction-service.js` §7 of the flow), which already has the actor, the target and
 *   `assertRange`. Measuring here too would mean measuring at a different moment from
 *   the one that authorized — two answers to the same question. The caller revalidates
 *   *immediately before* calling; `trade-service` does that.
 * - **It does not check permissions.** Same reason: permission belongs to the module that offered the
 *   action. This API is the notary, not the judge.
 * - **It does not talk to the client during the transaction.** `applyToClient` runs after
 *   the `commit`, always — the DB is the source of truth
 *   (`docs/technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md`).
 */

const db = require('../database');
const crypto = require('crypto');
const transactionService = require('./transaction-service');
const espm = require('./espm');
const ownerLib = require('./inventory-owner');

const { OWNER_TYPES } = ownerLib;

// ─────────────────────────────────────────────────────────────────────────────
// Limites
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many distinct `base_id`s a transfer can move.
 *
 * Each item produces two ledger rows and up to two locks, so the cap is the
 * budget of one transaction. 32 comfortably covers the largest plausible Heavy RP
 * trade; a "trade" of 500 items is a script, not a scene.
 */
const MAX_ITEMS_PER_TRANSFER = 32;

/** Per-item cap in a single operation. It is not the stack cap (that one is the DB's). */
const MAX_QUANTITY_PER_ITEM = 1_000_000;

/** `requestId`: 8 to 96, alphanumeric with `_ : . -`. Same spirit as §7 of the Interaction Framework. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_:.-]{8,96}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Storage adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An adapter says **where** an owner type's stock **lives**. It decides
 * nothing: it receives a connection with a transaction already open and applies the delta, or throws.
 *
 * @typedef {object} StorageAdapter
 * @property {(conn: object, owner: object, baseId: number, delta: number) => Promise<void>} applyDelta
 * @property {(runner: object, owner: object) => Promise<Array<{baseId: number, count: number}>>} list
 * @property {(conn: object, owner: object) => Promise<boolean>} [assertOwner]
 */

/** @type {Map<string, StorageAdapter>} */
const _adapters = new Map();

/**
 * Character: `character_inventory`, written by the `transaction-service`
 * primitive — the same one `giveItem`/`removeItem` use internally.
 * There is no second implementation of "how to touch a character's inventory".
 */
_adapters.set(OWNER_TYPES.CHARACTER, {
  applyDelta: (conn, owner, baseId, delta) =>
    transactionService.tx.applyStackDelta(conn, 'character_inventory', Number(owner.ref), baseId, delta),
  list: async (runner, owner) => {
    const rows = await runner.query(
      'SELECT base_id, count FROM character_inventory WHERE character_id = ? AND count > 0 ORDER BY base_id',
      [Number(owner.ref)]
    );
    return normalizeRows(rows);
  }
});

/**
 * Registered chest: `container_inventory`, keyed by `containers.id`.
 *
 * `assertOwner` exists because a made-up `containers.id` would only hit the FK
 * on the `INSERT` — and the error would arrive as a raw SQL failure, without saying the
 * chest does not exist. Checking inside the transaction also prevents the race "the chest
 * was deleted between validation and the write".
 */
_adapters.set(OWNER_TYPES.CONTAINER, {
  applyDelta: (conn, owner, baseId, delta) =>
    transactionService.tx.applyStackDelta(conn, 'container_inventory', Number(owner.ref), baseId, delta),
  list: async (runner, owner) => {
    const rows = await runner.query(
      'SELECT base_id, count FROM container_inventory WHERE container_id = ? AND count > 0 ORDER BY base_id',
      [Number(owner.ref)]
    );
    return normalizeRows(rows);
  },
  assertOwner: async (conn, owner) => {
    const [rows] = await conn.query('SELECT id FROM containers WHERE id = ?', [Number(owner.ref)]);
    return rows.length > 0;
  }
});

/**
 * Registers the adapter for an owner type that does not have one yet.
 *
 * Called in the `initialize()` of whoever owns that type, exactly like
 * `interactionTargets.registerResolver`. The core does not need to know it
 * exists, and a type without an adapter fails closed and by name.
 *
 * @param {string} ownerType
 * @param {StorageAdapter} adapter
 */
function registerAdapter(ownerType, adapter) {
  if (!(/** @type {string[]} */ (Object.values(OWNER_TYPES))).includes(ownerType)) {
    throw new Error(`[inventory] unknown owner type: ${JSON.stringify(ownerType)}`);
  }
  if (ownerType === OWNER_TYPES.SYSTEM) {
    throw new Error('[inventory] the `system` owner has no storage by definition');
  }
  if (!adapter || typeof adapter.applyDelta !== 'function' || typeof adapter.list !== 'function') {
    throw new Error(`[inventory] adapter for '${ownerType}' needs applyDelta and list`);
  }
  if (_adapters.has(ownerType)) {
    throw new Error(`[inventory] '${ownerType}' already has an adapter`);
  }
  _adapters.set(ownerType, adapter);
}

/** Types that can store items today. `system` is not one: it is the void. */
function supportedOwnerTypes() {
  return [...Object.values(OWNER_TYPES)].filter(t => t === OWNER_TYPES.SYSTEM || _adapters.has(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/** `mysql2` returns `count` as a number; a different driver would return a string. */
function normalizeRows(rows) {
  return (rows || []).map(r => ({ baseId: Number(r.base_id), count: Number(r.count) }));
}

/**
 * A new `requestId`, for whoever did not receive one from the client.
 *
 * The prefix is the caller's and goes into the log; the random part is what makes the key unique.
 * A `Date.now()` does **not** work — that was exactly the defect in `craftItem`
 * (audit §5): two consecutive calls produced different keys, and the
 * idempotency the comment promised never existed.
 *
 * @param {string} prefix
 */
function newRequestId(prefix = 'inv') {
  const limpo = String(prefix).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'inv';
  return `${limpo}:${uuid().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Checks and normalizes the item list.
 *
 * Sums quantities of the same `base_id` instead of refusing: `[{A,2},{A,3}]` is a
 * legitimate request from a UI that added up two stacks, and keeping them separate would create
 * two locks for the same row inside the same transaction.
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, code: string|null, reason: string|null, items: ItemPedido[]}}
 */
function normalizeItems(raw) {
  const recusar = (code, reason) => ({ ok: false, code, reason, items: [] });

  const lista = Array.isArray(raw) ? raw : [raw];
  if (lista.length === 0) {
    return recusar('EMPTY', 'No items in the transfer.');
  }
  if (lista.length > MAX_ITEMS_PER_TRANSFER) {
    return recusar('TOO_MANY', `At most ${MAX_ITEMS_PER_TRANSFER} items per transfer.`);
  }

  /** @type {Map<number, number>} */
  const somados = new Map();

  for (const entrada of lista) {
    if (!entrada || typeof entrada !== 'object') {
      return recusar('INVALID_ITEM', 'Malformed item.');
    }
    const baseId = entrada.baseId;
    const quantity = entrada.quantity;

    // `Number.isSafeInteger` rejects NaN, Infinity, 1.5 and 1e400 in one go. It is the
    // barrier §19 of the request calls "negative quantity, NaN, overflow".
    if (!Number.isSafeInteger(baseId) || baseId <= 0) {
      return recusar('INVALID_ITEM', 'Invalid FormID.');
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return recusar('INVALID_QUANTITY', 'Invalid quantity.');
    }
    if (quantity > MAX_QUANTITY_PER_ITEM) {
      return recusar('INVALID_QUANTITY', `Quantity above the maximum (${MAX_QUANTITY_PER_ITEM}).`);
    }

    // `pareceItem` returns `ok` when it does not know (no `mp`, old server). It only
    // refuses when the API answered and said that FormID does not go into an
    // inventory. It is a typo diagnostic, not an authority — see core/espm.js.
    const veredito = espm.pareceItem(baseId);
    if (!veredito.ok) {
      return recusar('UNKNOWN_FORMID', `Invalid item: ${veredito.motivo}.`);
    }

    const anterior = somados.get(baseId) || 0;
    if (anterior + quantity > MAX_QUANTITY_PER_ITEM) {
      return recusar('INVALID_QUANTITY', `Quantity above the maximum (${MAX_QUANTITY_PER_ITEM}).`);
    }
    somados.set(baseId, anterior + quantity);
  }

  const items = [...somados.entries()]
    .map(([baseId, quantity]) => ({ baseId, quantity }))
    .sort((a, b) => a.baseId - b.baseId);

  return { ok: true, code: null, reason: null, items };
}

/**
 * The idempotency key of the transfer's **first** ledger row.
 *
 * The anchor must be deterministic because it is what the replay looks for, and
 * it must be unique because it is what `UNIQUE (idempotency_key)` protects. The
 * other rows get `#1`, `#2`, … with the same prefix.
 *
 * @param {string} requestId
 * @param {number} indice
 */
function ledgerKey(requestId, indice) {
  return `${requestId}#${indice}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// A API
// ─────────────────────────────────────────────────────────────────────────────

/** How many legs an exchange can have. Two cover trade and craft; eight is headroom. */
const MAX_LEGS = 8;

/**
 * @typedef {{baseId: number, quantity: number}} ItemPedido
 * @typedef {{from: object, to: object, items: ItemPedido[]}} PernaResolvida
 */

/**
 * The result of any movement, in a **single shape**.
 *
 * ─── Why it is not a discriminated union ────────────────────────────────────
 *
 * `{ok: true, …} | {ok: false, code, reason}` would be the natural modeling, and it is the
 * one that was here first. This package's `jsconfig.json` runs with
 * `strictNullChecks: false` — deliberately, and the reason is written there: the
 * existing code was not written with types in mind, and turning on `strict` all at
 * once would produce hundreds of errors nobody would read.
 *
 * Without `strictNullChecks`, TypeScript **does not narrow** a union by literal, so
 * every `if (!r.ok) return r.reason` becomes an error in `npm run typecheck` — in the
 * caller, not here. An API whose correct use lights up the type checker is
 * an API that teaches people to ignore the type checker.
 *
 * The single shape solves it without lying: the failure fields are `null` on success and
 * the success fields are empty on failure. Whoever consumes it reads `ok` and moves on.
 *
 * @typedef {object} ResultadoDeInventario
 * @property {boolean} ok
 * @property {string|null} code        stable code for the caller to branch on
 * @property {string|null} reason      sentence the player may see
 * @property {string|null} transferId  UUID grouping the legs in the ledger
 * @property {boolean} duplicate       the request had already been applied before
 * @property {PernaResolvida[]} legs
 * @property {ItemPedido[]} items      shortcut to the first leg
 */

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ResultadoDeInventario}
 */
function falha(code, reason) {
  return { ok: false, code, reason, transferId: null, duplicate: false, legs: [], items: [] };
}

/**
 * @param {string} transferId
 * @param {boolean} duplicate
 * @param {PernaResolvida[]} legs
 * @returns {ResultadoDeInventario}
 */
function sucesso(transferId, duplicate, legs) {
  return {
    ok: true, code: null, reason: null,
    transferId, duplicate, legs,
    items: legs.length > 0 ? legs[0].items : []
  };
}

/**
 * Moves items between **several pairs** of owners, in a single transaction.
 *
 * ─── Why the primitive is this one, and not `transfer` ──────────────────────
 *
 * The two operations that motivated this file have more than one leg, in
 * different directions:
 *
 *   - **Craft** consumes ingredients (character → `system:consume`) and delivers
 *     the result (`system:craft` → character). Two `transfer` calls
 *     would be two transactions — exactly the defect `craftItem` carried until
 *     Phase 3, with the player losing the ingredient and receiving nothing.
 *   - **Trade** moves A's items to B *and* B's items to A. If the two legs
 *     do not commit together, one of them is a donation.
 *
 * `transfer` still exists because most calls have a single leg,
 * and it is the one that reads better at the call site.
 *
 * @param {object} opts
 * @param {Array<{from: object, to: object, items: any}>} opts.legs
 * @param {string} opts.reason    short reason, goes into the ledger
 * @param {string} opts.module    source module
 * @param {string} opts.requestId idempotency key — **mandatory**
 * @returns {Promise<ResultadoDeInventario>}
 */
async function exchange(opts) {
  const { legs: legsRaw, reason, module: mod, requestId } = opts || {};

  // ── Validation outside the transaction ─────────────────────────────────
  // Everything that can be refused without touching the DB is refused before taking a
  // connection from the pool. A malformed payload should not cost a `getConnection`.

  if (!Array.isArray(legsRaw) || legsRaw.length === 0) {
    return falha('EMPTY', 'Nothing in the transfer.');
  }
  if (legsRaw.length > MAX_LEGS) {
    return falha('TOO_MANY', `At most ${MAX_LEGS} legs per transfer.`);
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    return falha('INVALID_REQUEST_ID', 'Invalid request id.');
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 64) {
    return falha('INVALID_REASON', 'Invalid reason.');
  }
  if (typeof mod !== 'string' || !mod.trim() || mod.length > 32) {
    return falha('INVALID_MODULE', 'Invalid module.');
  }

  /** @type {Array<{from: object, to: object, items: Array<{baseId:number, quantity:number}>}>} */
  const legs = [];
  let totalItens = 0;

  for (const bruta of legsRaw) {
    const from = bruta && bruta.from;
    const to = bruta && bruta.to;

    if (!from || !to || typeof from !== 'object' || typeof to !== 'object') {
      return falha('INVALID_OWNER', 'Missing source or destination owner.');
    }
    if (ownerLib.isSame(from, to)) {
      return falha('SAME_OWNER', 'Source and destination are the same owner.');
    }
    for (const lado of [from, to]) {
      if (!ownerLib.isVoid(lado) && !_adapters.has(lado.type)) {
        // Mesma resposta do Interaction Framework para tipo de alvo sem
        // resolvedor: fechada, nomeada, sem ensinar a sondar o servidor.
        console.warn(`[inventory] sem adaptador para dono '${lado.type}'`);
        return falha('NO_ADAPTER', 'Unsupported owner type.');
      }
    }

    const normalizados = normalizeItems(bruta.items);
    if (!normalizados.ok) return falha(normalizados.code, normalizados.reason);

    totalItens += normalizados.items.length;
    if (totalItens > MAX_ITEMS_PER_TRANSFER) {
      return falha('TOO_MANY', `At most ${MAX_ITEMS_PER_TRANSFER} items per transfer.`);
    }

    legs.push({ from, to, items: normalizados.items });
  }

  // ── Global lock order ───────────────────────────────────────────────────
  //
  // A transfer A→B and another B→A running at the same time would lock in
  // opposite order and deadlock. Ordering the operations by (owner key,
  // base_id) gives **every** transfer on the server the same lock acquisition
  // order, which makes the cycle impossible instead of unlikely.
  //
  // The `Map` accumulates deltas for the same (owner, item) coming from different legs:
  // a trade where both sides offer the same potion needs **one**
  // lock per side, not two, otherwise the second waits on the first inside its
  // own transaction.
  /** @type {Map<string, {owner: object, baseId: number, delta: number}>} */
  const porLinha = new Map();
  for (const leg of legs) {
    for (const item of leg.items) {
      for (const [dono, delta] of [[leg.from, -item.quantity], [leg.to, item.quantity]]) {
        if (ownerLib.isVoid(dono)) continue;
        const chave = `${ownerLib.key(dono)}|${item.baseId}`;
        const existente = porLinha.get(chave);
        if (existente) existente.delta += delta;
        else porLinha.set(chave, { owner: dono, baseId: item.baseId, delta });
      }
    }
  }

  const operacoes = [...porLinha.values()]
    .filter(op => op.delta !== 0)
    .sort((a, b) => {
      const ka = ownerLib.key(a.owner);
      const kb = ownerLib.key(b.owner);
      return ka === kb ? a.baseId - b.baseId : ka.localeCompare(kb);
    });

  const transferId = uuid();
  const ancora = ledgerKey(requestId, 0);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // ── Replay INSIDE the transaction ──────────────────────────────────────
    //
    // Audit §7: `giveItem` and `removeItem` check the key with `db.query`,
    // on a different connection from the one that opens the transaction. Two
    // concurrent calls with the same key both read zero, both proceed, and the
    // `UNIQUE` kills the second on INSERT — the item does not duplicate, but the return
    // becomes `false`, and a caller with compensation (the stall's `addItem`)
    // would refund items for an operation that succeeded.
    //
    // Here the `SELECT ... FOR UPDATE` on the unique key holds the gap: the
    // second call **waits** for the first and then reads its result.
    // It is what the stall's `findPurchaseReplay` already did.
    const [replay] = await conn.query(
      'SELECT transfer_id FROM inventory_transactions WHERE idempotency_key = ? FOR UPDATE',
      [ancora]
    );
    if (replay.length > 0) {
      await conn.commit();
      console.log(`[inventory] exchange replay: request=${requestId} transfer=${replay[0].transfer_id}`);
      return sucesso(replay[0].transfer_id, true, legs);
    }

    // Does the owner exist? Only for types that can answer. Inside the transaction, so
    // the answer is still valid when it is used.
    const jaConferidos = new Set();
    for (const leg of legs) {
      for (const lado of [leg.from, leg.to]) {
        if (ownerLib.isVoid(lado)) continue;
        const chave = ownerLib.key(lado);
        if (jaConferidos.has(chave)) continue;
        jaConferidos.add(chave);

        const adapter = _adapters.get(lado.type);
        if (typeof adapter.assertOwner === 'function') {
          const existe = await adapter.assertOwner(conn, lado);
          if (!existe) throw new RegraViolada(`Owner not found: ${lado.label}`, 'OWNER_NOT_FOUND');
        }
      }
    }

    for (const op of operacoes) {
      await _adapters.get(op.owner.type).applyDelta(conn, op.owner, op.baseId, op.delta);
    }

    // ── Ledger: both legs, always ──────────────────────────────────────────
    //
    // Including the `system` leg. That is what gives the ledger the invariant it
    // did not have: for any `transfer_id`, the sum of the `delta`s is zero. Without the
    // void's leg, creating and destroying items would be indistinguishable from an
    // accounting error.
    //
    // Rows are per **declared leg**, not per DB row touched: a
    // trade where both sides offer the same potion touches a single row on
    // each side (the `Map` above summed them), but the ledger has to record both
    // offers, otherwise the statement does not tell what happened.
    let indice = 0;
    for (const leg of legs) {
      for (const item of leg.items) {
        for (const [dono, contraparte, delta] of [
          [leg.from, leg.to, -item.quantity],
          [leg.to, leg.from, item.quantity]
        ]) {
          await transactionService.tx.recordInventoryLedger(conn, {
            characterId: dono.type === OWNER_TYPES.CHARACTER ? Number(dono.ref) : null,
            ownerType: dono.type,
            ownerRef: dono.ref,
            counterpartyType: contraparte.type,
            counterpartyRef: contraparte.ref,
            transferId,
            baseId: item.baseId,
            delta,
            reason,
            module: mod,
            idempotencyKey: ledgerKey(requestId, indice++)
          });
        }
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();

    const regra = err instanceof RegraViolada
      || /insufficient|does not own|Stack full|Owner not found/i.test(err.message);
    if (!regra) {
      // An SQL error carries table and column names. It goes to the log, never
      // to the screen — the same fix the stall purchase already got.
      console.error(`[inventory] exchange falhou (${requestId}):`, err.message);
    }
    return falha(
      regra ? (err.code || 'INSUFFICIENT') : 'DB',
      regra ? err.message : 'Could not complete the operation.'
    );
  } finally {
    conn.release();
  }

  // ── After the commit: the client ────────────────────────────────────────
  //
  // O banco já é a fonte de verdade — nunca desfaz o que commitou. Item que
  // não chega ao jogo de quem recebe (offline, ou AddItem falhou) fica em
  // character_inventory_pending e é entregue no próximo login.
  for (const leg of legs) {
    for (const item of leg.items) {
      if (leg.from.type === OWNER_TYPES.CHARACTER && leg.from.actorId) {
        transactionService.tx.applyToClient(leg.from.actorId, item.baseId, -item.quantity);
      }
      if (leg.to.type === OWNER_TYPES.CHARACTER) {
        await transactionService.tx.deliverToCharacter(leg.to.actorId, leg.to.characterId, item.baseId, item.quantity);
      }
    }
  }

  const resumo = legs.map(l => `${ownerLib.key(l.from)}->${ownerLib.key(l.to)}(${l.items.length})`).join(' ');
  console.log(`[inventory] exchange ${resumo} (${reason}) transfer=${transferId}`);
  return sucesso(transferId, false, legs);
}

/**
 * Moves items between two owners. The single-leg form of `exchange`, which is the
 * case for the vast majority of calls.
 *
 * @param {object} opts
 * @param {object} opts.from   source owner (`core/inventory-owner.js`)
 * @param {object} opts.to     destination owner
 * @param {Array<{baseId:number, quantity:number}>|{baseId:number, quantity:number}} opts.items
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} opts.requestId
 * @returns {Promise<ResultadoDeInventario>}
 */
function transfer({ from, to, items, reason, module: mod, requestId }) {
  return exchange({ legs: [{ from, to, items }], reason, module: mod, requestId });
}

/**
 * A **rule** error, which the player may see. Separate from an infrastructure error,
 * which they may not: the distinction exists since the stall purchase fix, and
 * here it gets a type instead of depending only on matching the message.
 */
class RegraViolada extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'RegraViolada';
    this.code = code;
  }
}

/**
 * Creates items. Sugar over `transfer` with a `system` source.
 * @param {{to: object, items: any, source: string, reason: string, module: string, requestId: string}} opts
 */
function mint({ to, items, source, reason, module: mod, requestId }) {
  return transfer({ from: ownerLib.system(source), to, items, reason, module: mod, requestId });
}

/**
 * Destroys items. Sugar over `transfer` with a `system` destination.
 * @param {{from: object, items: any, source: string, reason: string, module: string, requestId: string}} opts
 */
function burn({ from, items, source, reason, module: mod, requestId }) {
  return transfer({ from, to: ownerLib.system(source), items, reason, module: mod, requestId });
}

/**
 * Stock of an item for an owner. A read without a transaction — good for building a
 * screen, **never** for deciding whether the operation fits: between this read and the
 * write the value can change, and what guarantees it is the `FOR UPDATE` in `applyDelta`.
 *
 * @param {object} owner
 * @param {number} baseId
 * @returns {Promise<number>}
 */
async function getStack(owner, baseId) {
  if (ownerLib.isVoid(owner)) return 0;
  const linhas = await list(owner);
  const achado = linhas.find(l => l.baseId === baseId);
  return achado ? achado.count : 0;
}

/**
 * All of an owner's stock.
 * @param {object} owner
 * @returns {Promise<Array<{baseId:number, count:number}>>}
 */
async function list(owner) {
  if (!owner || ownerLib.isVoid(owner)) return [];
  const adapter = _adapters.get(owner.type);
  if (!adapter) return [];
  return adapter.list(db, owner);
}

/**
 * An owner's statement: both ends of every movement that touched it.
 *
 * It is the query audit §2 said was impossible — *"where did this item
 * come from?"* — and that `migration-v14` made possible by naming the other side.
 *
 * @param {object} owner
 * @param {number} [limit]
 */
async function history(owner, limit = 50) {
  const teto = Number.isSafeInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
  return db.query(
    `SELECT transaction_id, transfer_id, base_id, delta, reason, module,
            counterparty_type, counterparty_ref, created_at
       FROM inventory_transactions
      WHERE owner_type = ? AND owner_ref = ?
      ORDER BY created_at DESC, transaction_id DESC
      LIMIT ${teto}`,
    [owner.type, owner.ref]
  );
}

/** Test only: resets the adapter registry to its factory state. */
function _resetAdapters() {
  for (const tipo of [..._adapters.keys()]) {
    if (tipo !== OWNER_TYPES.CHARACTER && tipo !== OWNER_TYPES.CONTAINER) _adapters.delete(tipo);
  }
}

module.exports = {
  // vocabulary
  OWNER_TYPES,
  SYSTEM_SOURCES: ownerLib.SYSTEM_SOURCES,
  owner: ownerLib.owner,
  character: ownerLib.character,
  container: ownerLib.container,
  system: ownerLib.system,

  // movimento
  exchange,
  transfer,
  mint,
  burn,
  MAX_LEGS,

  // leitura
  getStack,
  list,
  history,

  // extension
  registerAdapter,
  supportedOwnerTypes,

  // utilidades
  newRequestId,
  RegraViolada,
  MAX_ITEMS_PER_TRANSFER,
  MAX_QUANTITY_PER_ITEM,

  // tests
  _normalizeItems: normalizeItems,
  _resetAdapters
};
