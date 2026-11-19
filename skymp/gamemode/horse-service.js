/**
 * horse-service.js
 * Sistema de Cavalos Persistentes.
 *
 * O cavalo é um ator no mundo do Skyrim. Quando o servidor inicia,
 * os cavalos de jogadores são re-spawned na última posição salva.
 * A saúde e posição são persistidas a cada 30s (ticker).
 *
 * Mecânicas:
 * - /myhorse          → Mostra o status do cavalo
 * - /callhorse        → "Chama" o cavalo (teleporta perto do jogador)
 * - /namehorse [nome] → Renomeia o cavalo
 * - /sellhorse [actorId] [preço] → Coloca à venda para outro jogador
 * - /buyhorse [id]    → Compra cavalo listado
 */

const db = require('./database');
// Ver nota em economy-regional.js: ouro so pelo transaction-service.
const transactionService = require('./core/transaction-service');
const commands = require('./commands');

// FormIDs de raças de cavalos vanilla (Skyrim.esm)
const HORSE_BREEDS = {
  0x0010BF82: { name: 'Bay Horse',       base_price: 1000 },
  0x00012E49: { name: 'Black Horse',     base_price: 1200 },
  0x0010BF83: { name: 'Paint Horse',     base_price: 1100 },
  0x0010BF81: { name: 'Palomino Horse',  base_price: 900  },
  0x0010BF84: { name: 'White Horse',     base_price: 1300 },
};

// Cache em memória: characterId -> { horseId, name, health, actorRefId }
const mountedHorses = new Map();

/**
 * Carrega o cavalo de um personagem ao logar.
 */
async function loadHorse(actorId, characterId) {
  const rows = await db.query(
    'SELECT * FROM horses WHERE owner_character_id = ? LIMIT 1',
    [characterId]
  );
  if (rows.length === 0) return;
  const horse = rows[0];
  mountedHorses.set(characterId, { horseId: horse.id, name: horse.name, health: horse.health, actorId });
  console.log(`[horse] Loaded horse "${horse.name}" for char ${characterId}`);
}

/**
 * Ticker: salva posição e saúde dos cavalos ativos a cada 30s.
 */
async function tickHorses() {
  for (const [charId, data] of mountedHorses.entries()) {
    // Atualiza no banco (posição seria detectada via mp.get no futuro)
    await db.query(
      'UPDATE horses SET health = ? WHERE id = ?',
      [data.health, data.horseId]
    );
  }
}

function startHorseService() {
  setInterval(tickHorses, 30 * 1000);
  console.log('[horse] Horse service started (30s persist tick).');
}

/**
 * /myhorse — Exibe status do cavalo.
 */
async function showHorse(actorId, characterId) {
  const rows = await db.query('SELECT * FROM horses WHERE owner_character_id = ?', [characterId]);
  if (rows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['You do not own a horse.']);
    return;
  }
  const h = rows[0];
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      `🐴 ${h.name} | HP: ${Math.round(h.health)} | Bonus: +${h.speed_bonus.toFixed(0)}%${h.for_sale?' | FOR SALE for '+h.sale_price+'g':''}`
    ]);
  }
}

/**
 * /callhorse — Teleporta o cavalo para junto do jogador.
 */
async function callHorse(actorId, characterId) {
  const rows = await db.query('SELECT id, name FROM horses WHERE owner_character_id = ?', [characterId]);
  if (rows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['You do not own a horse.']);
    return;
  }
  // O SkyMP ainda não suporta spawn dinâmico de NPCs acompanhantes —
  // por ora emitimos uma notificação narrativa e salvamos intenção.
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      `${rows[0].name} gallops toward you...`
    ]);
  }
  commands.broadcastProximityMessage(actorId, `* Whistles for their horse.`, 800);
}

/**
 * /namehorse [nome] — Renomeia o cavalo.
 */
async function nameHorse(actorId, characterId, newName) {
  if (!newName || newName.length < 2) return;
  const res = await db.query(
    'UPDATE horses SET name = ? WHERE owner_character_id = ?',
    [newName.substring(0, 48), characterId]
  );
  if (res.affectedRows > 0) {
    const data = mountedHorses.get(characterId);
    if (data) data.name = newName;
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Your horse is now named "${newName}".`]);
  } else {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['You do not own a horse.']);
  }
}

/**
 * /sellhorse [preço] — Coloca o cavalo à venda no mercado.
 */
async function listHorseForSale(actorId, characterId, price) {
  if (price <= 0) return;
  await db.query('UPDATE horses SET for_sale=1, sale_price=? WHERE owner_character_id=?', [price, characterId]);
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Your horse is for sale for ${price}g. Use /horselist to see all of them.`]);
  }
}

/**
 * /horselist — Lista cavalos à venda.
 */
async function listHorses(actorId) {
  const rows = await db.query(
    `SELECT h.id, h.name, h.sale_price, c.first_name, c.last_name
     FROM horses h INNER JOIN characters c ON c.id = h.owner_character_id
     WHERE h.for_sale = 1 LIMIT 10`
  );
  if (rows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['No horses for sale right now.']);
    return;
  }
  const summary = rows.map(h => `[ID:${h.id}] ${h.name} for ${h.sale_price}g (${h.first_name})`).join(' | ');
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [summary]);
}

/**
 * /buyhorse [id] — Compra um cavalo listado.
 */
async function buyHorse(actorId, characterId, horseId) {
  // Verifica se já possui cavalo
  const owned = await db.query('SELECT id FROM horses WHERE owner_character_id = ?', [characterId]);
  if (owned.length > 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['You already own a horse. Sell it first.']);
    return;
  }
  const rows = await db.query('SELECT * FROM horses WHERE id = ? AND for_sale = 1', [horseId]);
  if (rows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Horse not found or already sold.']);
    return;
  }
  const horse = rows[0];
  const paid = await transactionService.removeGold({ characterId, amount: horse.sale_price, reason: 'horse_purchase', module: 'horse' });
  if (!paid) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Not enough gold. Price: ${horse.sale_price}g.`]);
    return;
  }
  // Transfere lucro ao antigo dono
  if (horse.owner_character_id) {
    await transactionService.addGold({ characterId: horse.owner_character_id, amount: horse.sale_price, reason: 'horse_sale', module: 'horse' });
  }
  await db.query('UPDATE horses SET owner_character_id=?, for_sale=0, sale_price=0 WHERE id=?', [characterId, horseId]);
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`You bought "${horse.name}" for ${horse.sale_price}g!`]);
  }
  console.log(`[horse] Char ${characterId} bought horse ${horseId} for ${horse.sale_price}g`);
}

module.exports = { startHorseService, loadHorse, showHorse, callHorse, nameHorse, listHorseForSale, listHorses, buyHorse };
