/**
 * economy-regional.js
 * Economia Regional com Oferta, Demanda e Impostos por Hold (Fase Beta).
 *
 * Mecânica:
 * - Cada Hold tem preços de compra/venda independentes.
 * - Estoque (stock) cai quando jogadores vendem; sobe com tempo.
 * - Quando estoque está alto (saturado), o preço de venda cai (oferta>demanda).
 * - Quando estoque está baixo, o preço de venda sobe (demanda>oferta).
 * - Sobre toda transação, um imposto (tax_rate do Hold) vai ao tesouro regional.
 */

const db = require('./database');
// Compra e venda usam uma fronteira unica: inventario, ouro, estoque, imposto
// e os tres ledgers so ficam visiveis depois do mesmo COMMIT.
const regionalMarketTransactions = require('./core/regional-market-transaction-service');
const institutionalTreasury = require('./core/institutional-treasury-service');
const admin = require('./admin-service');
const commands = require('./commands');

// Hold atual de cada personagem (será detectado por posição futuramente)
// Por ora, 'whiterun' como padrão
const characterHold = new Map(); // characterId -> holdId

// Cache dos preços (recarregado a cada 5min)
let pricesCache = {};
let holdCache   = {};

async function loadCache() {
  const holds = await db.query('SELECT * FROM holds');
  holdCache = {};
  for (const h of holds) holdCache[h.id] = h;

  const prices = await db.query('SELECT * FROM market_prices');
  pricesCache = {};
  for (const p of prices) {
    if (!pricesCache[p.hold_id]) pricesCache[p.hold_id] = {};
    pricesCache[p.hold_id][p.base_id] = p;
  }
  console.log(`[economy-regional] Cache loaded: ${holds.length} holds, ${prices.length} price entries.`);
}

async function refreshCacheAfterCommit(operation) {
  try {
    await loadCache();
  } catch (err) {
    // O commit ja aconteceu; cache atrasado nao pode transformar uma compra ou
    // venda confirmada em erro para o jogador. A proxima recarga periodica
    // tentara novamente e a transacao continua consultando o banco como fonte
    // de verdade.
    console.error(`[economy-regional] Cache nao recarregado apos ${operation}:`, err.message);
  }
}

setInterval(() => {
  loadCache().catch(err => console.error('[economy-regional] Falha ao recarregar cache:', err.message));
}, 5 * 60 * 1000);

async function initRegionalEconomy() {
  await loadCache();
  // Ticker de restoque: a cada 15 minutos restaura 5% do estoque
  setInterval(() => {
    restockTick().catch(err => console.error('[economy-regional] Falha no restockTick:', err.message));
  }, 15 * 60 * 1000);
  console.log('[economy-regional] Regional economy initialized.');
}

async function restockTick() {
  await db.query('UPDATE market_prices SET stock = LEAST(stock + 5, 100)');
  await loadCache();
}

function getBaseValue(entry) {
  if (!entry) return 15; // default base value
  // Usamos o buy_price do DB como base
  return entry.buy_price || 15;
}

/**
 * Preco que o NPC paga ao jogador (Spread punitivo: 40% do base)
 */
function getDynamicSellPrice(stock, baseValue) {
  let price = baseValue * 0.4;
  if (stock >= 70) price *= 0.5; // Muito estoque = paga miseria
  if (stock <= 30) price *= 1.5; // Pouco estoque = paga um pouco melhor
  return Math.max(1, Math.floor(price));
}

/**
 * Preco que o NPC cobra do jogador (Spread punitivo: 180% do base)
 */
function getDynamicBuyPrice(stock, baseValue) {
  let price = baseValue * 1.8;
  if (stock <= 30) price *= 1.4; // Pouco estoque = cobra absurdo
  if (stock >= 70) price *= 0.8; // Muito estoque = cobra um pouco menos
  return Math.max(1, Math.floor(price));
}

/**
 * /sell [baseId] [qty] — Vende item ao mercado regional do Hold atual.
 */
async function sellToMarket(actorId, characterId, baseId, qty = 1, idempotencyKey) {
  const holdId = characterHold.get(characterId) || 'whiterun';
  let result;
  try {
    result = await regionalMarketTransactions.sell({ actorId, characterId, holdId, baseId, count: qty, idempotencyKey });
  } catch (err) {
    console.error(`[economy-regional] Falha atomica na venda em ${holdId}:`, err.message);
    const message = /Insufficient stock|does not own item/i.test(err.message)
      ? 'You do not have enough items.'
      : 'Technical failure: the sale was not completed.';
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [message]);
    return false;
  }
  if (!result.ok) {
    const messages = {
      invalid_character: 'Invalid character.', invalid_item: 'Invalid ID.', invalid_count: 'Invalid quantity.',
      invalid_idempotency_key: 'Invalid request. Try again.', invalid_hold: 'Invalid market.',
      hold_not_found: 'Market unavailable in this city.'
    };
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [messages[result.code] || 'Sale refused.']);
    return false;
  }
  if (!result.replayed) await refreshCacheAfterCommit('venda');

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      result.replayed
        ? `Sale of ${qty}x item was already confirmed.`
        : `Sold ${qty}x item for ${result.net}g (tax: ${result.tax}g to ${holdCache[holdId]?.name || holdId}).`
    ]);
  }
  console.log(`[economy-regional] Char ${characterId} sold ${qty}x 0x${baseId.toString(16)} for ${result.net}g (+${result.tax}g tax) in ${holdId}${result.replayed ? ' (replay)' : ''}`);
  return true;
}

/**
 * /buyitem [baseId] [qty] — Compra item do mercado regional.
 */
async function buyFromMarket(actorId, characterId, baseId, qty = 1, idempotencyKey) {
  const holdId = characterHold.get(characterId) || 'whiterun';
  let result;
  try {
    result = await regionalMarketTransactions.buy({ actorId, characterId, holdId, baseId, count: qty, idempotencyKey });
  } catch (err) {
    console.error(`[economy-regional] Falha atomica na compra em ${holdId}:`, err.message);
    const message = /Insufficient gold/i.test(err.message) ? 'Insufficient gold.' : 'Technical failure: the purchase was not completed.';
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [message]);
    return false;
  }
  if (!result.ok) {
    const messages = {
      invalid_character: 'Invalid character.', invalid_item: 'Invalid ID.', invalid_count: 'Invalid quantity.',
      invalid_idempotency_key: 'Invalid request. Try again.', invalid_hold: 'Invalid market.',
      out_of_stock: 'Item unavailable in this market.'
    };
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [messages[result.code] || 'Purchase refused.']);
    return false;
  }
  if (!result.replayed) await refreshCacheAfterCommit('compra');

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      result.replayed ? `Purchase of ${qty}x item was already confirmed.` : `Bought ${qty}x item for ${result.gross}g.`
    ]);
  }
  return true;
}

/**
 * /marketinfo — Exibe preços do mercado local do Hold atual.
 */
async function showMarketInfo(actorId, characterId) {
  const holdId = characterHold.get(characterId) || 'whiterun';
  const hold   = holdCache[holdId];
  if (!hold) return;

  const prices = Object.values(pricesCache[holdId] || {}).slice(0, 5);
  if (prices.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['This market has no registered items.']);
    return;
  }

  const summary = prices.map(p => {
    const base = getBaseValue(p);
    const buy = getDynamicBuyPrice(p.stock, base);
    const sell = getDynamicSellPrice(p.stock, base);
    return `0x${p.base_id.toString(16)}: buy=${buy}g, sell=${sell}g (stock:${p.stock})`;
  }).join(' | ');
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`[${hold.name}] ${summary}`]);
}

/**
 * Atualiza o Hold atual de um personagem (chamado por detecção de posição).
 */
function setCharacterHold(characterId, holdId) {
  characterHold.set(characterId, holdId);
}

/**
 * Lord: /holdwithdraw [amount] - Saca impostos da cidade para o cofre da facção.
 */
async function withdrawHoldTreasury(actorId, characterId, amount, idempotencyKey) {
  const holdId = characterHold.get(characterId) || 'whiterun';
  let result;
  try {
    result = await institutionalTreasury.transferHoldTreasury({
      characterId,
      holdId,
      amount,
      idempotencyKey
    });
  } catch (err) {
    console.error(`[economy-regional] Falha atomica no saque do hold ${holdId}:`, err.message);
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Technical failure: no gold was transferred.']);
    return false;
  }

  if (!result.ok) {
    const messages = {
      invalid_amount: 'Invalid amount.',
      invalid_idempotency_key: 'Invalid request. Try again.',
      hold_not_found: 'Unknown hold.',
      no_ruling_faction: 'This city has no lord.',
      not_ruling_leader: 'Only the Lord of this city can withdraw taxes.',
      insufficient_treasury: `Insufficient local treasury${result.treasury !== undefined ? `: ${result.treasury}g.` : '.'}`
    };
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [messages[result.code] || 'Transferencia recusada.']);
    return false;
  }

  if (!result.replayed) await refreshCacheAfterCommit('saque institucional');
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
    result.replayed
      ? `Transfer of ${result.amount}g was already confirmed.`
      : `You transferred ${result.amount}g from the city to the faction vault.`
  ]);
  console.log(`[economy-regional] Lord ${characterId} withdrew ${result.amount}g from ${holdId} to faction ${result.factionId}${result.replayed ? ' (replay)' : ''}.`);
  return true;
}

/**
 * Staff: /settax [holdId] [rate] — Define imposto de um Hold.
 *
 * Exige `set_gold`, e não uma permissão nova. `set_gold` já significa "a staff
 * escreve um número da economia por decreto, com audit log" — que é exatamente
 * isto, aplicado ao fluxo em vez do saldo. Inventar uma `manage_economy` para um
 * único sítio de chamada criaria um nome que nenhum cargo concede hoje.
 */
async function setTaxRate(actorId, holdId, rate) {
  if (!admin.hasPermission(actorId, 'set_gold')) return;
  await db.query('UPDATE holds SET tax_rate = ? WHERE id = ?', [rate, holdId]);
  await loadCache();
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Tax for ${holdId} set to ${(rate * 100).toFixed(1)}%.`]);
  const ch = commands.getActiveCharacterData(actorId);
  await admin.auditLog(ch?.accountId, null, 'economy:setTax', `hold=${holdId} rate=${rate}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Interaction Hooks
// ─────────────────────────────────────────────────────────────────────────────

async function getInteractionSections(actorId, targetActorId) {
  // Apenas NPCs (nao-players) oferecem o mercado regional
  const commands = require('./commands');
  const targetChar = commands.getActiveCharacterData(targetActorId);
  if (targetChar) return []; // Se tem data, eh player

  const ch = commands.getActiveCharacterData(actorId);
  if (!ch) return [];

  const holdId = characterHold.get(ch.characterId) || 'whiterun';
  const hold = holdCache[holdId];
  const holdName = hold ? hold.name : 'Regional';

  return [{
    id: 'npc_market',
    label: `${holdName} Market`,
    actions: [
      { action: 'npc.market_view', label: 'View Prices' },
      { action: 'npc.market_buy', label: 'Buy Item' },
      { action: 'npc.market_sell', label: 'Sell Item' }
    ]
  }];
}

async function handleInteractionAction(actorId, action, payload = {}) {
  const ch = commands.getActiveCharacterData(actorId);
  if (!ch) return;

  const baseId = parseDatabaseInteger(payload.baseId);
  const qty = payload.count === undefined ? 1 : parseDatabaseInteger(payload.count);

  switch (action) {
    case 'npc.market_view':
      return showMarketInfo(actorId, ch.characterId);
    case 'npc.market_buy':
      if (!baseId || !qty || qty > 100) {
        if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Invalid ID.']);
        return;
      }
      return buyFromMarket(actorId, ch.characterId, baseId, qty, payload.requestId);
    case 'npc.market_sell':
      if (!baseId || !qty || qty > 100) {
        if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Invalid ID.']);
        return;
      }
      return sellToMarket(actorId, ch.characterId, baseId, qty, payload.requestId);
  }
}

function parseDatabaseInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^(?:[1-9]\d*|0x[0-9a-f]+)$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

module.exports = {
  initRegionalEconomy,
  sellToMarket,
  buyFromMarket,
  showMarketInfo,
  setCharacterHold,
  withdrawHoldTreasury,
  setTaxRate,
  getInteractionSections,
  handleInteractionAction
};
