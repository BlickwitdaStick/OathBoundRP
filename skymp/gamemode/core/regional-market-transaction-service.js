/** Transacoes atomicas do mercado regional (NPC). */

const crypto = require('crypto');
const database = require('../database');
const transactionService = require('./transaction-service');
const economyService = require('./economy-service');

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function positiveInteger(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function idempotencyKey(value) {
  if (value === undefined || value === null) return uuid();
  if (typeof value !== 'string') return null;
  const key = value.trim();
  // The gold and inventory ledgers use different suffixes of this key. The
  // limit leaves room for both within the regional table's VARCHAR(64) and
  // still accepts normal UUIDs and UI requestIds.
  return key.length >= 8 && key.length <= 48 ? key : null;
}

function baseValue(entry) {
  return Number.isSafeInteger(entry?.buy_price) && entry.buy_price > 0 ? entry.buy_price : 15;
}

function buyPrice(stock, value) {
  let price = value * 1.8;
  if (stock <= 30) price *= 1.4;
  if (stock >= 70) price *= 0.8;
  return Math.max(1, Math.floor(price));
}

function sellPrice(stock, value) {
  let price = value * 0.4;
  if (stock >= 70) price *= 0.5;
  if (stock <= 30) price *= 1.5;
  return Math.max(1, Math.floor(price));
}

function validate(request) {
  const count = positiveInteger(request?.count);
  if (!Number.isSafeInteger(request?.characterId) || request.characterId <= 0) return { code: 'invalid_character' };
  if (!Number.isSafeInteger(request?.actorId) || request.actorId <= 0) return { code: 'invalid_actor' };
  if (typeof request?.holdId !== 'string' || request.holdId.length === 0 || request.holdId.length > 32) return { code: 'invalid_hold' };
  if (!Number.isSafeInteger(request?.baseId) || request.baseId <= 0) return { code: 'invalid_item' };
  // Stock is capped at 100; allowing a larger quantity has no use
  // case and turns a UI mistake into an unnecessarily large operation.
  if (!count || count > 100) return { code: 'invalid_count' };
  const key = idempotencyKey(request?.idempotencyKey);
  if (!key) return { code: 'invalid_idempotency_key' };
  return { count, key };
}

async function replay(conn, key) {
  const [rows] = await conn.query(
    `SELECT transaction_id, direction, unit_price, gross_amount, tax_amount
     FROM regional_market_transactions WHERE idempotency_key = ? LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

async function record(conn, values) {
  const transactionId = uuid();
  await conn.query(
    `INSERT INTO regional_market_transactions
      (transaction_id, idempotency_key, actor_character_id, hold_id, direction,
       base_id, count, unit_price, gross_amount, tax_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [transactionId, values.key, values.characterId, values.holdId, values.direction,
      values.baseId, values.count, values.unitPrice, values.gross, values.tax]
  );
  return transactionId;
}

async function buy(request, dependencies = {}) {
  const valid = validate(request);
  if (valid.code) return { ok: false, code: valid.code };
  const db = dependencies.db || database;
  const tx = dependencies.tx || transactionService.tx;
  const economy = dependencies.economy || economyService;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const [priceRows] = await conn.query(
      'SELECT hold_id, base_id, buy_price, sell_price, stock FROM market_prices WHERE hold_id = ? AND base_id = ? FOR UPDATE',
      [request.holdId, request.baseId]
    );
    const priceEntry = priceRows[0];
    const prior = await replay(conn, valid.key);
    if (prior) return await finish(conn, replayResult(prior), () => { committed = true; });
    if (!priceEntry || priceEntry.stock < valid.count) return await finish(conn, { ok: false, code: 'out_of_stock' }, () => { committed = true; });

    const unitPrice = buyPrice(priceEntry.stock, baseValue(priceEntry));
    const gross = unitPrice * valid.count;
    // Buying from the NPC market destroys septims. Against `system:regional_market`,
    // that drain is listed — an undeclared drain is indistinguishable from gold
    // vanishing because of a bug (audit §9).
    const pagamento = await economy.transferInTransaction(conn, {
      from: { type: 'character', ref: request.characterId },
      to: { type: 'system', ref: 'regional_market' },
      amount: gross,
      reason: 'regional_purchase',
      module: 'economy-regional',
      actorCharacterId: request.characterId,
      idempotencyKey: `${valid.key}:gold`
    });
    if (!pagamento.ok) {
      return await finish(conn, { ok: false, code: pagamento.code }, () => { committed = true; });
    }
    await tx.applyInventoryDelta(conn, request.characterId, request.baseId, valid.count);
    const [stockUpdate] = await conn.query(
      'UPDATE market_prices SET stock = stock - ? WHERE hold_id = ? AND base_id = ? AND stock >= ?',
      [valid.count, request.holdId, request.baseId, valid.count]
    );
    if (stockUpdate.affectedRows !== 1) throw new Error('Regional stock changed during the purchase');
    // The gold ledger was already written by the transfer above.
    await tx.recordInventoryLedger(conn, { characterId: request.characterId, baseId: request.baseId, delta: valid.count, reason: 'regional_purchase', module: 'economy-regional', idempotencyKey: `${valid.key}:inventory` });
    const transactionId = await record(conn, { key: valid.key, characterId: request.characterId, holdId: request.holdId, direction: 'buy', baseId: request.baseId, count: valid.count, unitPrice, gross, tax: 0 });
    await conn.commit();
    committed = true;
    tx.applyToClient(request.actorId, request.baseId, valid.count);
    return { ok: true, replayed: false, transactionId, unitPrice, gross, tax: 0 };
  } catch (err) {
    if (!committed) await safeRollback(conn);
    throw err;
  } finally {
    conn.release();
  }
}

async function sell(request, dependencies = {}) {
  const valid = validate(request);
  if (valid.code) return { ok: false, code: valid.code };
  const db = dependencies.db || database;
  const tx = dependencies.tx || transactionService.tx;
  const economy = dependencies.economy || economyService;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const [holdRows] = await conn.query('SELECT id, tax_rate FROM holds WHERE id = ? FOR UPDATE', [request.holdId]);
    const hold = holdRows[0];
    if (!hold) return await finish(conn, { ok: false, code: 'hold_not_found' }, () => { committed = true; });
    const [priceRows] = await conn.query(
      'SELECT hold_id, base_id, buy_price, sell_price, stock FROM market_prices WHERE hold_id = ? AND base_id = ? FOR UPDATE',
      [request.holdId, request.baseId]
    );
    const priceEntry = priceRows[0];
    const prior = await replay(conn, valid.key);
    if (prior) return await finish(conn, replayResult(prior), () => { committed = true; });

    const stock = priceEntry ? priceEntry.stock : 50;
    const unitPrice = sellPrice(stock, baseValue(priceEntry));
    const gross = unitPrice * valid.count;
    const tax = Math.ceil(gross * Number(hold.tax_rate || 0));
    const net = gross - tax;
    await tx.applyInventoryDelta(conn, request.characterId, request.baseId, -valid.count);
    // The NPC pays the gross amount against `system:regional_market` — this is the point where
    // septims enter the world, and now they have a row instead of appearing out of nowhere.
    // Then the seller pays the tax to the Hold, which is the second transfer.
    // Until 2026-08-13 it was `applyGoldDelta(net)` + a loose `UPDATE holds SET treasury`:
    // the net amount arrived without saying where from, and the tax went into the treasury
    // without any trail (Finding 2 of `ECONOMY_FRAMEWORK_AUDIT.md`).
    const pagamento = await economy.transferInTransaction(conn, {
      from: { type: 'system', ref: 'regional_market' },
      to: { type: 'character', ref: request.characterId },
      amount: gross,
      reason: 'regional_sale',
      module: 'economy-regional',
      actorCharacterId: request.characterId,
      idempotencyKey: `${valid.key}:gold`
    });
    if (!pagamento.ok) throw new Error(`Regional payment refused: ${pagamento.code}`);

    if (tax > 0) {
      const imposto = await economy.transferInTransaction(conn, {
        from: { type: 'character', ref: request.characterId },
        to: { type: 'hold', ref: hold.id },
        amount: tax,
        reason: 'regional_tax',
        module: 'economy-regional',
        actorCharacterId: request.characterId,
        idempotencyKey: `${valid.key}:tax`
      });
      if (!imposto.ok) throw new Error(`Regional tax refused: ${imposto.code}`);
    }
    await conn.query(
      `INSERT INTO market_prices (hold_id, base_id, sell_price, buy_price, stock)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stock = LEAST(stock + ?, 100), sell_price = VALUES(sell_price), buy_price = VALUES(buy_price)`,
      [request.holdId, request.baseId, unitPrice, buyPrice(stock, baseValue(priceEntry)), Math.min(100, 50 + valid.count), valid.count]
    );
    await tx.recordInventoryLedger(conn, { characterId: request.characterId, baseId: request.baseId, delta: -valid.count, reason: 'regional_sale', module: 'economy-regional', idempotencyKey: `${valid.key}:inventory` });
    // The gold ledger was already written by the two transfers above.
    const transactionId = await record(conn, { key: valid.key, characterId: request.characterId, holdId: request.holdId, direction: 'sell', baseId: request.baseId, count: valid.count, unitPrice, gross, tax });
    await conn.commit();
    committed = true;
    tx.applyToClient(request.actorId, request.baseId, -valid.count);
    return { ok: true, replayed: false, transactionId, unitPrice, gross, tax, net };
  } catch (err) {
    if (!committed) await safeRollback(conn);
    throw err;
  } finally {
    conn.release();
  }
}

async function finish(conn, result, committed) {
  await conn.commit();
  committed();
  return result;
}

async function safeRollback(conn) {
  try { await conn.rollback(); } catch { /* keep the original error */ }
}

function replayResult(row) {
  return { ok: true, replayed: true, transactionId: row.transaction_id, unitPrice: row.unit_price, gross: row.gross_amount, tax: row.tax_amount };
}

module.exports = { buy, sell, buyPrice, sellPrice, positiveInteger, idempotencyKey };
