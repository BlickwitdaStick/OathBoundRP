/**
 * core/transaction-service.js
 *
 * Atomic transaction service for inventory and gold.
 * EVERY change to a character's items or gold MUST go through here.
 *
 * Guarantees:
 * - Consistency: DB and client always in sync within a transaction
 * - Atomicity: BEGIN/COMMIT/ROLLBACK via mysql2
 * - Auditing: ledger in inventory_transactions and gold_transactions
 * - Idempotency: idempotency_key prevents duplicates on retries
 */

const db = require('../database');
const crypto = require('crypto');
const { actorRef } = require('./papyrus');

/**
 * Generates a simple UUID v4 using the native crypto module.
 */
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/**
 * Records an item transaction in the ledger.
 * @param {object} conn - Connection with an active transaction
 * @param {object} opts
 * @param {number|null} opts.characterId
 * @param {number} opts.baseId
 * @param {number} opts.delta - positive = gained, negative = lost
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string|null} [opts.idempotencyKey]
 * @param {string} [opts.ownerType] - default `character` (migration v14)
 * @param {string|number} [opts.ownerRef] - default the `characterId` itself
 * @param {string} [opts.counterpartyType] - the other side of the movement
 * @param {string|number} [opts.counterpartyRef]
 * @param {string} [opts.transferId] - UUID shared by the legs of the same transfer
 */
async function _recordInventoryLedger(conn, opts) {
  const txId = uuid();

  // `owner_*` and `counterparty_*` came in with migration v14 (Inventory
  // Framework). Whoever passes nothing keeps writing exactly the same row as
  // before: owner `character`, ref equal to `character_id`, null counterparty.
  // That is what keeps `giveItem`/`removeItem` and the callers of the primitives
  // unchanged while `core/inventory.js` names both sides.
  const ownerType = opts.ownerType || 'character';
  const ownerRef = opts.ownerRef !== undefined && opts.ownerRef !== null
    ? String(opts.ownerRef)
    : String(opts.characterId);

  await conn.query(
    `INSERT INTO inventory_transactions
      (transaction_id, character_id, owner_type, owner_ref,
       counterparty_type, counterparty_ref, transfer_id,
       base_id, delta, reason, module, idempotency_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed')`,
    [
      txId,
      opts.characterId === undefined ? null : opts.characterId,
      ownerType, ownerRef,
      opts.counterpartyType || null, opts.counterpartyRef || null,
      opts.transferId || null,
      opts.baseId, opts.delta, opts.reason, opts.module, opts.idempotencyKey || null
    ]
  );
  return txId;
}

/**
 * Records a gold transaction in the ledger.
 *
 * `owner_*` and `counterparty_*` came in with migration v15 (Economy Framework),
 * with exactly the shape v14 gave the item ledger and for the same reason:
 * a sale wrote `-100` on the buyer and `+95` on the seller with nothing linking the
 * two rows (`ECONOMY_FRAMEWORK_AUDIT.md` Finding 1).
 *
 * Whoever passes nothing keeps writing exactly the same row as before: holder
 * `character`, ref equal to `character_id`, null counterparty. That is what keeps
 * `addGold`/`removeGold` and the callers of the primitives unchanged while
 * `core/economy-service.js` names both sides.
 *
 * @param {object} conn connection with an active transaction
 * @param {object} opts
 * @param {number|null} [opts.characterId] set when the holder is a character
 * @param {number} opts.delta positive credits, negative debits
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} [opts.idempotencyKey]
 * @param {string} [opts.ownerType] default `character`
 * @param {string|number} [opts.ownerRef] default the `characterId` itself
 * @param {string} [opts.counterpartyType] the other side of the movement
 * @param {string|number} [opts.counterpartyRef]
 * @param {string} [opts.transferId] UUID shared by the legs of the same transfer
 * @param {number} [opts.actorCharacterId] who asked for the movement, if not the holder
 */
async function _recordGoldLedger(conn, opts) {
  const txId = uuid();
  const ownerType = opts.ownerType || 'character';
  const ownerRef = opts.ownerRef !== undefined && opts.ownerRef !== null
    ? String(opts.ownerRef)
    : String(opts.characterId);

  await conn.query(
    `INSERT INTO gold_transactions
      (transaction_id, character_id, owner_type, owner_ref,
       counterparty_type, counterparty_ref, transfer_id, actor_character_id,
       delta, reason, module, idempotency_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed')`,
    [
      txId,
      opts.characterId === undefined ? null : opts.characterId,
      ownerType, ownerRef,
      opts.counterpartyType || null,
      opts.counterpartyRef === undefined || opts.counterpartyRef === null ? null : String(opts.counterpartyRef),
      opts.transferId || null,
      Number.isSafeInteger(opts.actorCharacterId) && opts.actorCharacterId > 0 ? opts.actorCharacterId : null,
      opts.delta, opts.reason, opts.module, opts.idempotencyKey || null
    ]
  );
  return txId;
}

/**
 * Stack tables `(owner, base_id, count)` this file knows how to write.
 *
 * ─── Why it is a closed list, and not a parameter ───────────────────────────
 *
 * `_applyStackDelta` builds SQL with the table and column names interpolated —
 * a `?` placeholder does not work for identifiers. A closed list here is
 * what makes that interpolation safe by construction: no name coming from a
 * module, configuration or payload reaches the SQL. A new owner comes in by
 * editing this object, under review, which is the same criterion as the list of sources
 * in `core/inventory-owner.js`.
 *
 * `market_stall_items` **is not here on purpose**: it carries price,
 * label and status per listing, so it is not a stack. See
 * `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §1.1.
 */
const STACK_TABLES = Object.freeze({
  character_inventory: 'character_id',
  container_inventory: 'container_id',
  // Depot Service (migration-v20-depot-service.sql): regional storage, same
  // shape (owner, base_id, count) as the two tables above. An atomic deposit/withdrawal
  // is two `applyStackDelta` calls (character_inventory +
  // depot_inventory) in the caller's same transaction — see core/depot-service.js.
  depot_inventory: 'depot_id'
});

/**
 * The largest value that fits in MySQL's `count INT`.
 *
 * The guard exists because `UPDATE ... SET count = count + ?` in non-strict mode
 * saturates silently instead of failing: a player with 2,147,483,000 arrows
 * receiving 1,000 more would end up with 2,147,483,647, and the difference would become a
 * destroyed item without any row explaining it. Better to refuse the operation.
 */
const MAX_STACK_COUNT = 2147483647;

/**
 * Updates a stack table inside the **caller's** transaction.
 * It neither creates nor destroys the transaction, it only runs queries.
 *
 * Generalized on 2026-08-13: it used to be hardwired to `character_inventory`, and
 * `core/inventory.js` needs the same semantics (the `FOR UPDATE`, the refusal on
 * insufficient stock, the `DELETE` when it hits zero) for containers. Two copies
 * of this is the defect that exporting the `tx.*` primitives exists to avoid.
 *
 * ─── Validation ────────────────────────────────────────────────────────────
 *
 * It is new and it is §6 of the audit: the public functions (`giveItem`,
 * `removeItem`) checked `count <= 0`, and this primitive — the exported one,
 * used directly by crafting and stalls — checked nothing. `delta = NaN` fell into the
 * removal branch, passed the comparison (`x < NaN` is always `false`) and
 * wrote `count = NaN`.
 *
 * @param {object} conn connection with an active transaction
 * @param {string} table a key of `STACK_TABLES`
 * @param {number} ownerId value of the owner column
 * @param {number} baseId FormID
 * @param {number} delta positive credits, negative debits; zero is refused
 */
async function _applyStackDelta(conn, table, ownerId, baseId, delta) {
  const ownerColumn = STACK_TABLES[table];
  if (!ownerColumn) {
    throw new Error(`[transaction] unknown stack table: ${JSON.stringify(table)}`);
  }
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error(`[transaction] invalid owner in ${table}: ${JSON.stringify(ownerId)}`);
  }
  if (!Number.isSafeInteger(baseId) || baseId <= 0) {
    throw new Error(`[transaction] invalid baseId: ${JSON.stringify(baseId)}`);
  }
  // `delta = 0` is refused, not ignored: it would get here from a calculation
  // that went wrong somewhere, and writing a ledger row with a zero delta
  // would hide that error behind a "successful" operation.
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new Error(`[transaction] invalid delta for 0x${Number(baseId).toString(16)}: ${JSON.stringify(delta)}`);
  }

  // FOR UPDATE locks the row (or the gap, if it does not exist yet) inside the
  // active transaction in conn — a second concurrent call for the same (owner, base_id)
  // blocks here until the first one commits/rolls back, instead of reading the same stale
  // value and overwriting it (the original bug allowed duplicating/losing items when
  // two operations ran in parallel, e.g. stall_add + stall_pack).
  const [rows] = await conn.query(
    `SELECT count FROM ${table} WHERE ${ownerColumn} = ? AND base_id = ? FOR UPDATE`,
    [ownerId, baseId]
  );

  if (delta > 0) {
    const atual = rows.length > 0 ? Number(rows[0].count) : 0;
    if (atual + delta > MAX_STACK_COUNT) {
      throw new Error(`Stack full: ${atual} + ${delta} exceeds the limit of ${MAX_STACK_COUNT}`);
    }
    if (rows.length > 0) {
      await conn.query(
        `UPDATE ${table} SET count = count + ? WHERE ${ownerColumn} = ? AND base_id = ?`,
        [delta, ownerId, baseId]
      );
    } else {
      await conn.query(
        `INSERT INTO ${table} (${ownerColumn}, base_id, count) VALUES (?, ?, ?)`,
        [ownerId, baseId, delta]
      );
    }
  } else {
    // Remove items (delta is negative)
    if (rows.length === 0) {
      throw new Error(`Owner ${ownerId} does not own item 0x${baseId.toString(16)}`);
    }
    const currentCount = Number(rows[0].count);
    const remove = Math.abs(delta);
    if (currentCount < remove) throw new Error(`Insufficient stock: have ${currentCount}, need ${remove}`);
    const newCount = currentCount - remove;
    if (newCount <= 0) {
      await conn.query(`DELETE FROM ${table} WHERE ${ownerColumn} = ? AND base_id = ?`, [ownerId, baseId]);
    } else {
      await conn.query(
        `UPDATE ${table} SET count = ? WHERE ${ownerColumn} = ? AND base_id = ?`,
        [newCount, ownerId, baseId]
      );
    }
  }
}

/**
 * Updates `character_inventory` inside an active transaction.
 * It is still the name crafting and stalls call; today it is an alias of
 * `_applyStackDelta` with the character table.
 */
async function _applyInventoryDelta(conn, characterId, baseId, delta) {
  return _applyStackDelta(conn, 'character_inventory', characterId, baseId, delta);
}

/**
 * The largest value that fits in MySQL's `characters.gold INT`.
 *
 * It exists for the same reason as `MAX_STACK_COUNT`: `gold = gold + ?` in
 * non-strict mode saturates silently instead of failing, and the difference becomes
 * destroyed wealth without any row explaining it. The asymmetry — a cap for
 * items, none for gold — was Finding 4 of `ECONOMY_FRAMEWORK_AUDIT.md`.
 */
const MAX_GOLD = 2147483647;

/**
 * Updates the character's gold inside the **caller's** transaction.
 *
 * ─── Validation ─────────────────────────────────────────────────────────────
 *
 * It is new and it is Finding 3 of the economy audit — the same defect that §6
 * of the inventory audit fixed for items and did not carry over to money. The
 * previous version validated nothing: `delta = NaN` fell outside the debit branch
 * (`NaN < 0` is `false`), reached the `UPDATE` and wrote `gold = gold + NaN`, which
 * non-strict MySQL stores as `0` — **the player's wealth silently became
 * zero**. It is the same class as the bug `/setgold` once had.
 *
 * `delta = 0` is refused, not ignored, for the same reason as the item path:
 * it would get here from a calculation that went wrong, and writing a
 * ledger row with a zero delta would hide that error behind a
 * "successful" operation.
 *
 * ─── Why the SELECT now happens in both directions ──────────────────────────
 *
 * Before, only the debit read the row. The credit went straight to the `UPDATE`, which had
 * three consequences: crediting a nonexistent character affected 0 rows without
 * anyone checking, there was no way to refuse an `INT` overflow, and the order in which
 * rows were locked depended on the direction of the operation — which is what produces the
 * cross-purchase deadlock (Finding 10). Always reading costs one query and solves
 * all three; the canonical lock ordering is `economy-service`'s job.
 */
async function _applyGoldDelta(conn, characterId, delta) {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(`[transaction] invalid character for gold: ${JSON.stringify(characterId)}`);
  }
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new Error(`[transaction] invalid gold delta: ${JSON.stringify(delta)}`);
  }

  // FOR UPDATE serializes concurrent operations on the same character — without it,
  // two simultaneous removals could both read the old balance, both pass the
  // sufficient-balance check, and the relative UPDATE (gold = gold + ?) would still leave
  // the balance negative.
  const [rows] = await conn.query('SELECT gold FROM characters WHERE id = ? FOR UPDATE', [characterId]);
  if (rows.length === 0) throw new Error(`Character ${characterId} not found`);
  const atual = Number(rows[0].gold);

  if (delta < 0) {
    if (atual + delta < 0) throw new Error(`Insufficient gold: have ${atual}, need ${Math.abs(delta)}`);
  } else if (atual + delta > MAX_GOLD) {
    throw new Error(`Wealth cap reached: ${atual} + ${delta} exceeds the limit of ${MAX_GOLD}`);
  }

  await conn.query('UPDATE characters SET gold = gold + ? WHERE id = ?', [delta, characterId]);
}

/**
 * Applies the change on the SkyMP client (no DB transaction, just a side effect).
 * Called AFTER the COMMIT to guarantee the DB is the source of truth.
 * On failure, the item is in the DB but not on the client → it will be fixed by reconciliation.
 */
function _applyToClient(actorId, baseId, delta) {
  if (typeof mp === 'undefined') return;
  try {
    if (delta > 0) {
      mp.callPapyrusFunction('method', 'ObjectReference', 'AddItem', actorRef(actorId), [baseId, delta, true]);
    } else {
      mp.callPapyrusFunction('method', 'ObjectReference', 'RemoveItem', actorRef(actorId), [baseId, Math.abs(delta), true, null]);
    }
  } catch (err) {
    // Log without throwing: the DB is already correct. Reconciliation will take care of the client on the next reconnect.
    console.error(`[transaction] Warning: failed to apply item 0x${baseId.toString(16)} on client ${actorId ? actorId.toString(16) : '?'}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grants an item to the character (DB + client + ledger).
 *
 * @param {object} opts
 * @param {number} opts.actorId      - SkyMP actor (to apply on the client)
 * @param {number} opts.characterId  - character ID in the database
 * @param {number} opts.baseId       - native Skyrim FormID
 * @param {number} opts.count        - quantity to grant (positive)
 * @param {string} opts.reason       - reason (e.g. 'admin_give', 'woodcutting')
 * @param {string} opts.module       - source module (e.g. 'admin', 'jobs')
 * @param {string} [opts.idempotencyKey] - unique key to prevent duplicates
 * @returns {Promise<boolean>}
 */
async function giveItem(opts) {
  const { actorId, characterId, baseId, count, reason, module: mod, idempotencyKey } = opts;
  if (count <= 0) throw new Error('count must be positive');

  // Idempotency check before the transaction
  if (idempotencyKey) {
    const existing = await db.query(
      'SELECT transaction_id FROM inventory_transactions WHERE idempotency_key = ?',
      [idempotencyKey]
    );
    if (existing.length > 0) {
      console.log(`[transaction] giveItem idempotent skip: key=${idempotencyKey}`);
      return true;
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await _applyInventoryDelta(conn, characterId, baseId, count);
    await _recordInventoryLedger(conn, { characterId, baseId, delta: count, reason, module: mod, idempotencyKey });
    await conn.commit();
    _applyToClient(actorId, baseId, count);
    console.log(`[transaction] giveItem: char=${characterId} item=0x${baseId.toString(16)} x${count} (${reason})`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(`[transaction] giveItem failed: char=${characterId} item=0x${baseId.toString(16)}:`, err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * Removes an item from the character (DB + client + ledger).
 *
 * @param {object} opts
 * @param {number} opts.actorId
 * @param {number} opts.characterId
 * @param {number} opts.baseId
 * @param {number} opts.count
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<boolean>}
 */
async function removeItem(opts) {
  const { actorId, characterId, baseId, count, reason, module: mod, idempotencyKey } = opts;
  if (count <= 0) throw new Error('count must be positive');

  if (idempotencyKey) {
    const existing = await db.query(
      'SELECT transaction_id FROM inventory_transactions WHERE idempotency_key = ?',
      [idempotencyKey]
    );
    if (existing.length > 0) {
      console.log(`[transaction] removeItem idempotent skip: key=${idempotencyKey}`);
      return true;
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await _applyInventoryDelta(conn, characterId, baseId, -count);
    await _recordInventoryLedger(conn, { characterId, baseId, delta: -count, reason, module: mod, idempotencyKey });
    await conn.commit();
    _applyToClient(actorId, baseId, -count);
    console.log(`[transaction] removeItem: char=${characterId} item=0x${baseId.toString(16)} x${count} (${reason})`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(`[transaction] removeItem failed: char=${characterId} item=0x${baseId.toString(16)}:`, err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * Atomic transfer of item + gold between two characters (for trading).
 * Runs everything in a single transaction: the DB is the source of truth.
 *
 * @param {object} opts
 * @param {number} opts.fromActorId
 * @param {number} opts.fromCharacterId
 * @param {number} opts.toActorId
 * @param {number} opts.toCharacterId
 * @param {number} opts.baseId         - item to transfer (0 if gold only)
 * @param {number} opts.itemCount      - item quantity
 * @param {number} opts.goldAmount     - gold to transfer (0 if item only)
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<boolean>}
 */
async function transfer(opts) {
  const {
    fromActorId, fromCharacterId,
    toActorId, toCharacterId,
    baseId, itemCount = 0,
    goldAmount = 0,
    reason, module: mod, idempotencyKey
  } = opts;

  if (idempotencyKey) {
    const existing = await db.query(
      'SELECT transaction_id FROM inventory_transactions WHERE idempotency_key = ? UNION SELECT transaction_id FROM gold_transactions WHERE idempotency_key = ?',
      [idempotencyKey, idempotencyKey]
    );
    if (existing.length > 0) {
      console.log(`[transaction] transfer idempotent skip: key=${idempotencyKey}`);
      return true;
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (itemCount > 0 && baseId > 0) {
      await _applyInventoryDelta(conn, fromCharacterId, baseId, -itemCount);
      await _applyInventoryDelta(conn, toCharacterId, baseId, itemCount);
      const itemKey = idempotencyKey ? `${idempotencyKey}_item` : null;
      await _recordInventoryLedger(conn, { characterId: fromCharacterId, baseId, delta: -itemCount, reason, module: mod, idempotencyKey: itemKey ? `${itemKey}_from` : null });
      await _recordInventoryLedger(conn, { characterId: toCharacterId, baseId, delta: itemCount, reason, module: mod, idempotencyKey: itemKey ? `${itemKey}_to` : null });
    }

    if (goldAmount > 0) {
      await _applyGoldDelta(conn, fromCharacterId, -goldAmount);
      await _applyGoldDelta(conn, toCharacterId, goldAmount);
      const goldKey = idempotencyKey ? `${idempotencyKey}_gold` : null;
      await _recordGoldLedger(conn, { characterId: fromCharacterId, delta: -goldAmount, reason, module: mod, idempotencyKey: goldKey ? `${goldKey}_from` : null });
      await _recordGoldLedger(conn, { characterId: toCharacterId, delta: goldAmount, reason, module: mod, idempotencyKey: goldKey ? `${goldKey}_to` : null });
    }

    await conn.commit();

    // Apply on the client after COMMIT
    if (itemCount > 0 && baseId > 0) {
      _applyToClient(fromActorId, baseId, -itemCount);
      _applyToClient(toActorId, baseId, itemCount);
    }

    console.log(`[transaction] transfer: char=${fromCharacterId}→${toCharacterId} item=0x${(baseId||0).toString(16)} x${itemCount} gold=${goldAmount} (${reason})`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(`[transaction] transfer failed:`, err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * Grants gold to a character (DB + ledger), atomic via _applyGoldDelta.
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {number} opts.amount - positive
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<boolean>}
 */
async function addGold(opts) {
  const { characterId, amount, reason, module: mod, idempotencyKey } = opts;
  if (amount <= 0) throw new Error('amount must be positive');

  if (idempotencyKey) {
    const existing = await db.query('SELECT transaction_id FROM gold_transactions WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing.length > 0) {
      console.log(`[transaction] addGold idempotent skip: key=${idempotencyKey}`);
      return true;
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await _applyGoldDelta(conn, characterId, amount);
    await _recordGoldLedger(conn, { characterId, delta: amount, reason, module: mod, idempotencyKey });
    await conn.commit();
    console.log(`[transaction] addGold: char=${characterId} +${amount}g (${reason})`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(`[transaction] addGold failed: char=${characterId}:`, err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * Removes gold from a character (DB + ledger), atomic via _applyGoldDelta —
 * refuses (returns false) if the balance is insufficient, without leaving the balance negative
 * even under concurrency (the row is locked with FOR UPDATE inside the transaction).
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {number} opts.amount - positive
 * @param {string} opts.reason
 * @param {string} opts.module
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<boolean>}
 */
async function removeGold(opts) {
  const { characterId, amount, reason, module: mod, idempotencyKey } = opts;
  if (amount <= 0) throw new Error('amount must be positive');

  if (idempotencyKey) {
    const existing = await db.query('SELECT transaction_id FROM gold_transactions WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing.length > 0) {
      console.log(`[transaction] removeGold idempotent skip: key=${idempotencyKey}`);
      return true;
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await _applyGoldDelta(conn, characterId, -amount);
    await _recordGoldLedger(conn, { characterId, delta: -amount, reason, module: mod, idempotencyKey });
    await conn.commit();
    console.log(`[transaction] removeGold: char=${characterId} -${amount}g (${reason})`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(`[transaction] removeGold falhou (provavel saldo insuficiente): char=${characterId}:`, err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * Checks whether the character has enough of an item.
 * Uses the database as the source of truth (not the client's inventory).
 */
async function hasItem(characterId, baseId, minCount = 1) {
  const rows = await db.query(
    'SELECT count FROM character_inventory WHERE character_id = ? AND base_id = ?',
    [characterId, baseId]
  );
  return rows.length > 0 && rows[0].count >= minCount;
}

/**
 * Returns the character's current gold.
 */
async function getGold(characterId) {
  const rows = await db.query('SELECT gold FROM characters WHERE id = ?', [characterId]);
  return rows.length > 0 ? rows[0].gold : 0;
}

module.exports = {
  giveItem, removeItem, transfer, hasItem, getGold, addGold, removeGold,

  /**
   * Primitives that take part in the **caller's** transaction.
   *
   * ─── Why this is exported ─────────────────────────────────────────────────
   *
   * The public functions above open their own connection and their own transaction.
   * That is right for almost everything, and wrong for an operation that must
   * commit together with something else: a stall purchase moves gold, lowers
   * stock, credits the seller, charges the city's tax and delivers the item —
   * either all of it happens, or none of it does. Calling `removeGold()` followed by
   * `giveItem()` there would be two independent transactions, and a failure in the middle
   * would leave the buyer with neither gold nor item.
   *
   * Before this export, `market-stalls-service` solved that by writing
   * its own gold and inventory SQL inside its transaction — atomic and
   * with a ledger, but it was a second implementation of "how to touch gold",
   * outside the file that exists to be the only one. The balance `FOR UPDATE` and the
   * negative-balance protection were duplicated; any fix here
   * did not reach there.
   *
   * ─── Contract ────────────────────────────────────────────────────────────
   *
   * - The caller **opens, commits and rolls back** the transaction. These functions
   *   do none of the three.
   * - They throw when a rule is violated (insufficient balance, insufficient
   *   stock). The `rollback` is the caller's responsibility.
   * - `applyGoldDelta` and `applyInventoryDelta` lock the row with `FOR UPDATE`
   *   before reading, so two concurrent operations on the same character
   *   serialize instead of both reading the stale value.
   * - A balance or item change **without** the matching `record*Ledger` is
   *   untraceable gold or items. Always call both.
   * - `applyToClient` is the **only** one that runs after the `commit`, never inside
   *   the transaction: the DB is the source of truth, and the client is reconciled
   *   on login if that call fails.
   *
   * Use the public functions whenever the operation is isolated; use these only
   * when it must commit together with something else.
   */
  tx: {
    applyGoldDelta: _applyGoldDelta,
    applyInventoryDelta: _applyInventoryDelta,
    // Generalization of `applyInventoryDelta` to any table in
    // `STACK_TABLES`. Its user is `core/inventory.js`, which needs the same
    // locking and refusal semantics for containers.
    applyStackDelta: _applyStackDelta,
    STACK_TABLES,
    MAX_STACK_COUNT,
    MAX_GOLD,
    recordGoldLedger: _recordGoldLedger,
    recordInventoryLedger: _recordInventoryLedger,
    // Exported when `crafting-service` migrated: it needed to deliver the
    // result on the client after the commit, and the three copies that already existed
    // of that same `AddItem`/`RemoveItem` (here, in `market-stalls-service` and in
    // `inventory-service`) showed that a fourth one was the wrong path. It is the
    // same function `giveItem`/`removeItem` already used internally — the only thing that
    // changes is who may call it.
    applyToClient: _applyToClient
  },

  // Exposed only for tests: guarantees the Papyrus `self` goes as an object
  // `{type,desc}` and not as a raw FormID (see core/papyrus.js).
  _applyToClient
};
