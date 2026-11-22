/**
 * inventory-service.js — projecting the inventory onto the client
 *
 * ⚠️ **This file is not the Inventory Framework.** Since 2026-08-13, the central
 * item-movement API is `core/inventory.js`, and its documentation
 * is `docs/framework/INVENTORY_FRAMEWORK.md`. What remains here is the other
 * half of the subject: taking what the DB knows to the player's screen, and the three
 * historical shortcuts (`giveItem`/`removeItem`/`hasItem`) that are still valid
 * for the **single owner** case.
 *
 * Which one to use:
 *
 *   - one owner changes (staff gives an item, a reward) → from here, or transaction-service
 *   - **two** owners (trade, chest, stall, craft)       → `core/inventory.transfer`
 *
 * ─── Entrega no login ───────────────────────────────────────────────────────
 *
 * O SkyMP salva sozinho o inventário real de cada personagem
 * (`world/changeForms/*.json`, campo `inv`). `character_inventory` é o
 * registro do servidor, não uma cópia a reenviar: até 2026-11-21 o login dava
 * `AddItem` em todas as linhas dela, em cima do inventário salvo, e tudo que o
 * servidor já tinha dado (give do staff, job, troca) voltava depois de ser
 * largado, vendido, comido ou lido (spell tome) — uma vez por login.
 *
 * Agora `syncInventoryToClient` entrega só `character_inventory_pending`
 * (migration-v37): itens dados enquanto o personagem estava offline (ex.:
 * barraca expirada devolvendo mercadoria) ou cujo `AddItem` falhou. Quem
 * enfileira é `core/transaction-service.deliverToCharacter`. A pendência é
 * consumida antes do `AddItem` e devolvida se ele falhar, então reconectar
 * nunca entrega duas vezes.
 *
 * Limite conhecido: o que existe só no cliente (item pego do chão, saque de
 * NPC) continua fora do banco — `docs/technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md` §3.
 *
 * IMPORTANTE: Este serviço NÃO muda `character_inventory`. Toda mudança de
 * item usa core/transaction-service (atomicidade + ledger).
 */

const db = require('./database');
const transactionService = require('./core/transaction-service');
const { actorRef, baseRef } = require('./core/papyrus');

/**
 * Entrega no jogo os itens que ficaram pendentes para o personagem.
 * Nunca rejeita: falha é logada e a pendência fica para o próximo login.
 *
 * @param {number} actorId
 * @param {number} characterId
 */
async function syncInventoryToClient(actorId, characterId) {
  try {
    // Nunca entregar mais do que o banco diz que o personagem tem: algo
    // removido depois de enfileirado não deve aparecer.
    const rows = await db.query(
      `SELECT p.base_id, p.count AS pending, LEAST(p.count, COALESCE(ci.count, 0)) AS count
         FROM character_inventory_pending p
         LEFT JOIN (SELECT base_id, SUM(count) AS count FROM character_inventory
                     WHERE character_id = ? GROUP BY base_id) ci ON ci.base_id = p.base_id
        WHERE p.character_id = ?`,
      [characterId, characterId]
    );

    let delivered = 0;
    let failed = 0;

    for (const row of rows) {
      const count = Number(row.count);
      // Consumir primeiro: se o AddItem chegasse e a baixa falhasse depois, a
      // próxima reconexão entregaria de novo. Nesta ordem, o pior caso é a
      // pendência voltar para a fila.
      await _consumePending(characterId, row.base_id, Number(row.pending));
      if (!(count > 0)) continue;

      if (typeof mp === 'undefined') { delivered++; continue; }
      try {
        mp.callPapyrusFunction('method', 'ObjectReference', 'AddItem', actorRef(actorId), [baseRef(row.base_id), count, true]);
        delivered++;
      } catch (clientErr) {
        failed++;
        console.error(`[inventory] Aviso: falha ao entregar item pendente 0x${row.base_id.toString(16)} para actor ${actorId.toString(16)}:`, clientErr.message);
        await transactionService.queuePendingDelivery(characterId, row.base_id, count);
      }
    }

    if (rows.length > 0) {
      console.log(`[inventory] Login char ${characterId}: ${delivered} itens pendentes entregues, ${failed} ficam para o próximo login`);
    }
  } catch (err) {
    console.error(`[inventory] Erro ao entregar itens pendentes para char ${characterId}:`, err.message);
  }
}

async function _consumePending(characterId, baseId, count) {
  if (count > 0) {
    await db.query(
      'UPDATE character_inventory_pending SET count = count - ? WHERE character_id = ? AND base_id = ?',
      [count, characterId, baseId]
    );
  }
  await db.query(
    'DELETE FROM character_inventory_pending WHERE character_id = ? AND base_id = ? AND count <= 0',
    [characterId, baseId]
  );
}

/**
 * Grants an item to the character (uses transaction-service).
 * Convenience wrapper for legacy code that calls inventory-service directly.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function giveItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.giveItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Removes an item from the character (uses transaction-service).
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function removeItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.removeItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Checks whether the character has enough of an item.
 * Uses the database as the source of truth.
 *
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} [minCount]
 * @returns {Promise<boolean>}
 */
async function hasItem(characterId, baseId, minCount = 1) {
  return transactionService.hasItem(characterId, baseId, minCount);
}

module.exports = {
  syncInventoryToClient,
  giveItem,
  removeItem,
  hasItem
};
