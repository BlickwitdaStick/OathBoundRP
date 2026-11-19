// PARKED — see docs/technical/PARKED_SERVICES_DECISION.md §6.
//
// Migrated on 2026-08-13 to the Inventory Framework (`core/inventory.js`).
// Migrating is not reactivating: this module stays out of `core/module-registry.js`.
//
// ─── What was wrong ─────────────────────────────────────────────────────────
//
// `depositItem` did `inventoryService.removeItem()` — which **opens and commits its
// own transaction** — and only then two loose `db.query` calls on
// `container_inventory`, with no `BEGIN` and no lock. If either of the two
// failed, the item had already left the character and did not enter the chest: it **vanished**.
//
// It is the shape of `economy-service.transfer` (deleted on 2026-08-06) and of the
// pre-Phase-3 `craftItem`, now on containers. Third occurrence of the same
// pattern — see docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md §3.
//
// Now both ends commit together, through the API that exists for that.
const db = require('./database');
// See the note in economy-regional.js: gold only through transaction-service.
const transactionService = require('./core/transaction-service');
const inventory = require('./core/inventory');
const commands = require('./commands');

const MODULE = 'housing';

// Cache of open containers to avoid concurrent conflicts
// Key: objectId (formDesc), Value: { characterId, actorId, openedAt }
const openContainers = new Map();

/**
 * After this, an open chest session is considered abandoned.
 *
 * ─── Why a TTL and not a disconnect hook ────────────────────────────────────
 *
 * `closeContainer` has no caller outside this file — grep confirms it.
 * A player who dropped with the chest open left it **locked forever**,
 * until the server restarted, and nobody else could open it.
 *
 * The right hook is `removeActiveCharacter` in `commands.js`, and it cannot
 * be wired here: this module is PARKED, and `commands.js` must not know
 * a service the `module-registry` does not know — it is exactly the coupling
 * the `governance-service` comment cites as the worst possible idea.
 *
 * The TTL heals the case on its own, without depending on whoever turned the module off, and stays
 * valid after the hook exists. When this service is reactivated, its
 * `initialize()` is what subscribes to the disconnect.
 */
const CONTAINER_SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Checks whether a character has access to a container.
 * Returns the container from the DB, or null if there is no access.
 */
async function getContainerAccess(objectId, characterId) {
  const rows = await db.query('SELECT * FROM containers WHERE object_id = ?', [objectId]);
  if (rows.length === 0) {
    // Unregistered container: anyone can open it (open world)
    return { isPublic: true };
  }

  const container = rows[0];

  // The owner has full access
  if (container.owner_character_id === characterId) {
    return { ...container, isOwner: true };
  }

  // Check whether they are a guest of the associated property
  const propRows = await db.query(
    `SELECT p.id FROM properties p
     INNER JOIN property_guests pg ON pg.property_id = p.id
     WHERE p.container_id = ? AND pg.guest_character_id = ?`,
    [container.id, characterId]
  );
  if (propRows.length > 0) {
    return { ...container, isGuest: true };
  }

  return null; // No access
}

/**
 * Tries to open a container. Intercepts the door/chest activation on the server.
 */
async function openContainer(actorId, characterId, objectId) {
  try {
    const access = await getContainerAccess(objectId, characterId);
    if (!access) {
      if (typeof mp !== 'undefined') {
        mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Locked. You do not have permission to open this.']);
      }
      return false;
    }

    const sessaoAtual = openContainers.get(objectId);
    if (sessaoAtual && Date.now() - sessaoAtual.openedAt < CONTAINER_SESSION_TTL_MS) {
      if (sessaoAtual.characterId !== characterId) {
        if (typeof mp !== 'undefined') {
          mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['This container is already being used by someone else.']);
        }
        return false;
      }
    } else if (sessaoAtual) {
      // Expired session: whoever opened it dropped, or left the chest open.
      console.log(`[housing] Sessao expirada do container ${objectId} (char ${sessaoAtual.characterId}) liberada.`);
      openContainers.delete(objectId);
    }

    openContainers.set(objectId, { characterId, actorId, openedAt: Date.now() });
    console.log(`[housing] Char ${characterId} opened container ${objectId}`);

    // Inject the container's items onto the screen (future UI or native opening)
    await syncContainerToClient(actorId, objectId);
    return true;
  } catch (err) {
    console.error(`[housing] Error opening container ${objectId}:`, err.message);
    return false;
  }
}

/**
 * Syncs the container's contents to the client UI.
 */
async function syncContainerToClient(actorId, objectId) {
  const rows = await db.query(
    `SELECT ci.base_id, ci.count FROM container_inventory ci
     INNER JOIN containers c ON c.id = ci.container_id
     WHERE c.object_id = ?`,
    [objectId]
  );
  // For now: notifies the player with the item count
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Container: ${total} item(s).`]);
  }
  // In the future: send to the CEF UI via mp.triggerClient(actorId, 'openContainer', rows)
  console.log(`[housing] Synced container ${objectId} for actor ${actorId}: ${rows.length} item types`);
}

/**
 * Fecha o container liberando o lock.
 */
function closeContainer(objectId) {
  if (openContainers.has(objectId)) {
    openContainers.delete(objectId);
    console.log(`[housing] Container ${objectId} closed.`);
  }
}

/**
 * Checks the chest session and returns the object's `containers.id`, creating the
 * record if it does not exist yet.
 *
 * A single shape instead of a discriminated union, for the same reason explained in
 * `core/inventory.js`: `jsconfig.json` runs with `strictNullChecks: false` and
 * TypeScript does not narrow `{ok:true,…}|{ok:false,…}` without it.
 *
 * @returns {Promise<{ok: boolean, containerId: number|null, motivo: string|null}>}
 */
async function _resolveOpenContainer(characterId, objectId) {
  const recusar = (motivo) => ({ ok: false, containerId: null, motivo });

  const session = openContainers.get(objectId);
  if (!session || session.characterId !== characterId) {
    return recusar('You need to open the container first.');
  }
  if (Date.now() - session.openedAt >= CONTAINER_SESSION_TTL_MS) {
    openContainers.delete(objectId);
    return recusar('The chest session expired. Open it again.');
  }

  let cRows = await db.query('SELECT id FROM containers WHERE object_id = ?', [objectId]);
  if (cRows.length === 0) {
    await db.query('INSERT INTO containers (object_id, owner_character_id) VALUES (?, ?)', [objectId, characterId]);
    cRows = await db.query('SELECT id FROM containers WHERE object_id = ?', [objectId]);
  }
  if (cRows.length === 0) return recusar('Could not register this container.');

  return { ok: true, containerId: cRows[0].id, motivo: null };
}

/**
 * Transfers an item from the character to a container (deposit).
 *
 * One transaction, two ends, a ledger on both sides. The `requestId` makes a
 * double click idempotent: the second returns the result of the first instead of
 * depositing again.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {string} objectId  the chest's formDesc
 * @param {number} baseId
 * @param {number} count
 * @param {string} [requestId]
 */
async function depositItem(actorId, characterId, objectId, baseId, count, requestId) {
  const alvo = await _resolveOpenContainer(characterId, objectId);
  if (!alvo.ok) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [alvo.motivo]);
    return false;
  }

  const resultado = await inventory.transfer({
    from: inventory.character(characterId, actorId),
    to: inventory.container(alvo.containerId),
    items: [{ baseId, quantity: count }],
    reason: 'container_deposit',
    module: MODULE,
    requestId: requestId || inventory.newRequestId(`deposit.${characterId}`)
  });

  if (!resultado.ok) {
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [resultado.reason]);
    }
    return false;
  }

  console.log(`[housing] Char ${characterId} deposited ${count}x0x${Number(baseId).toString(16)} into ${objectId}`);
  return true;
}

/**
 * Transfers an item from the container to the character (withdraw).
 *
 * It did not exist. A chest you can only deposit into is not a chest — and the absence was
 * invisible because nothing called `depositItem` either. Written now because the
 * symmetry is what makes the container adapter exercisable in both directions.
 */
async function withdrawItem(actorId, characterId, objectId, baseId, count, requestId) {
  const alvo = await _resolveOpenContainer(characterId, objectId);
  if (!alvo.ok) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [alvo.motivo]);
    return false;
  }

  const resultado = await inventory.transfer({
    from: inventory.container(alvo.containerId),
    to: inventory.character(characterId, actorId),
    items: [{ baseId, quantity: count }],
    reason: 'container_withdraw',
    module: MODULE,
    requestId: requestId || inventory.newRequestId(`withdraw.${characterId}`)
  });

  if (!resultado.ok) {
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [resultado.reason]);
    }
    return false;
  }

  console.log(`[housing] Char ${characterId} withdrew ${count}x0x${Number(baseId).toString(16)} from ${objectId}`);
  return true;
}

/**
 * Buys a property listed for sale.
 */
async function buyProperty(actorId, characterId, propertyId) {
  const propRows = await db.query('SELECT * FROM properties WHERE id = ? AND is_for_sale = 1 AND owner_character_id IS NULL', [propertyId]);
  if (propRows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['This property is not for sale.']);
    return false;
  }

  const prop = propRows[0];
  const paid = await transactionService.removeGold({ characterId, amount: prop.price_gold, reason: 'property_purchase', module: 'housing' });
  if (!paid) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Not enough gold. Price: ${prop.price_gold} Septims.`]);
    return false;
  }

  await db.query('UPDATE properties SET owner_character_id = ?, is_for_sale = 0 WHERE id = ?', [characterId, propertyId]);
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`You bought "${prop.name}" for ${prop.price_gold} Septims!`]);
  console.log(`[housing] Char ${characterId} bought property ${propertyId} for ${prop.price_gold} gold.`);
  return true;
}

/**
 * Invites a character to a property.
 */
async function inviteToProperty(ownerCharId, targetCharId, propertyId) {
  const propRows = await db.query('SELECT id FROM properties WHERE id = ? AND owner_character_id = ?', [propertyId, ownerCharId]);
  if (propRows.length === 0) {
    return false;
  }

  await db.query(
    'INSERT IGNORE INTO property_guests (property_id, guest_character_id) VALUES (?, ?)',
    [propertyId, targetCharId]
  );
  console.log(`[housing] Char ${ownerCharId} invited Char ${targetCharId} to property ${propertyId}`);
  return true;
}

module.exports = {
  openContainer,
  closeContainer,
  depositItem,
  withdrawItem,
  buyProperty,
  inviteToProperty,
  getContainerAccess,

  // Test only: the session TTL is wall-clock time, and the test needs to
  // age a session without waiting five minutes.
  _openContainers: openContainers,
  CONTAINER_SESSION_TTL_MS
};
