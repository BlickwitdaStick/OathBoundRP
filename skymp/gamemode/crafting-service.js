
/**
 * crafting-service.js
 * Modular Crafting System (Beta Phase).
 *
 * Runs 100% server-side:
 * - The client sends an interaction request using [E] at a registered station.
 * - The server consumes the ingredients and delivers the result in a single transaction.
 *
 * WARNING: What this header used to claim, but which was not true.
 * Until 13/08/2026, this list said "the server validates ingredients,
 * station proximity, and perks."
 *
 * Ingredients: yes, through `FOR UPDATE`.
 * Station proximity: never — `craftItem` did not even load the station,
 * so `/craft` worked from anywhere on the map.
 * Perks: never — `requires_perk` was read in `listRecipes` but never
 * compared against anything.
 *
 * Since migration v28, player crafting exclusively goes through the
 * Interaction Framework: the server resolves the FormDesc in
 * `crafting_stations`, validates the physical distance, and derives
 * the `station_type`.
 *
 * `requires_perk` deliberately remains unused; profession/rank is the
 * adopted access requirement. See `docs/gameplay/CRAFTING_SYSTEM.md`.
 *
 * Registered in `core/module-registry.js` as the `crafting` module
 * (phase `lab`, `ENABLE_CRAFTING_SERVICE`, disabled by default).
 *
 * The migration below was an internal security improvement and was
 * deliberately kept separate from the decision to reactivate the module.
 * Mixing these two decisions is precisely the mistake that Phase 2 of
 * the QA_REPORT is intended to prevent repeating.
 *
 * See `docs/technical/PARKED_SERVICES_DECISION.md` §7.2 for the history.
 *
 * ─── Profession Gate (20/08/2026) ─────────────────────────────────────────
 *
 * `crafting_recipes.required_profession` / `required_rank`
 * (migration-v23-crafting-profession-gate.sql) are checked inside
 * `craftItem()`, following the same design that `resource_nodes.required_profession`
 * already uses with `profession-service.js`.
 *
 * NULL means unrestricted access for any character — no recipe currently
 * has this field populated, so this change does not alter behavior by itself.
 *
 * Staff can now restrict a recipe to `blacksmith`, `smelter`, `tanner`,
 * `enchanter`, or `cook` through `/addrecipe`.
 *
 * `requires_perk` remains unused — it is not the field this gate checks.
 *
 * ─── Maker's Mark (22/08/2026) ─────────────────────────────────────────────
 *
 * See `docs/design/MAKERS_MARK.md`.
 *
 * A crafter with a rank >= `crafting.signatureMinRank` can record a
 * dedication in `crafted_item_signatures` (migration-v24) when crafting
 * a recipe restricted to a profession.
 *
 * This is NOT part of the same transaction as `inventory.exchange`.
 *
 * This is a deliberate decision, not an oversight: `exchange()`
 * (`core/inventory.js`) does not expose a hook for external writes,
 * and extending that file (used by trade/depot/market-stall/crafting)
 * solely for this feature would introduce disproportionate risk
 * for the benefit gained.
 *
 * The signature is flavor metadata — it does not move gold or items —
 * so an isolated failure during the `INSERT` only generates a log entry.
 * There is no exploit or loss of assets, unlike what would happen with
 * an actual item transfer.
 *
 * See `recordCraftSignature` below.
 *
 * ─── Why This File Changed ─────────────────────────────────────────────────
 *
 * `craftItem` used to announce:
 * `// 4. Consume ingredients (safe transaction: all or nothing)`
 *
 * But it was neither safe nor all-or-nothing.
 *
 * It used a loop of independent `inventoryService.removeItem()` calls,
 * followed by `giveItem()`, and each of these functions opened its own
 * transaction through the transaction-service.
 *
 * A recipe with three ingredients therefore involved four separate
 * transactions. If the second operation failed, the first had already
 * committed, meaning the player lost the ingredient without receiving
 * anything.
 *
 * This was essentially `economy-service.transfer` (`removeGold` followed
 * by `addGold`, without a transaction), with a different noun — the same
 * defect that motivated deleting that file, now repeated with items instead
 * of gold.
 *
 * Phase 3 (07/08/2026) combined everything into a single transaction
 * using the `tx.*` primitives.
 *
 * On 13/08/2026, the same flow was moved to a single call to
 * `core/inventory.exchange`, with two legs:
 * ingredient consumption (character → `system:consume`) and
 * result delivery (`system:craft` → character).
 *
 * The improvement over the previous version is not atomicity — that
 * version was already correct.
 *
 * The improvement is that the other side of each movement now has a
 * named entry in the ledger, and the idempotency key is no longer useless
 * (see step 4 of `craftItem`).
 */

const crypto = require('crypto');
const db = require('./database');
const commands = require('./commands');
const inventory = require('./core/inventory');
const professionService = require('./profession-service');
const serverOptions = require('./core/server-options');
const interactionRegistry = require('./core/interaction-registry');
const physicalAnchorRegistry = require('./core/physical-anchor-registry');
const MODULE = 'crafting';

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/**
 * Records the Maker's Mark (docs/design/MAKERS_MARK.md).
 *
 * Called AFTER `inventory.exchange` has already committed — it is not
 * part of the same transaction (see this file's header).
 *
 * A failure here does not undo the craft: the player has already received
 * the item; only the record of who signed it will be missing.
 */
async function recordCraftSignature({ baseId, recipeId, makerCharacterId, ownerCharacterId, signatureText }) {
  try {
    await db.query(
      `INSERT INTO crafted_item_signatures
        (id, base_id, recipe_id, maker_character_id, owner_character_id, signature_text, crafted_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [uuid(), baseId, recipeId, makerCharacterId, ownerCharacterId, signatureText]
    );
  } catch (err) {
    console.error(`[crafting] Failed to record signature (recipe=${recipeId} maker=${makerCharacterId}):`, err.message);
  }
}

// Accepted station types in `crafting_stations` (actual Skyrim objects).
const STATION_TYPES = ['forge', 'cooking_pot', 'tanning_rack', 'alchemy_lab', 'enchanting_table'];

async function resolveStation(formId) {
  if (!Number.isSafeInteger(formId) || formId <= 0) return null;
  if (typeof mp === 'undefined' || typeof mp.getDescFromId !== 'function') return null;
  const rows = await db.query(
    'SELECT station_type FROM crafting_stations WHERE form_desc = ? AND enabled = 1',
    [mp.getDescFromId(formId)]
  );
  return rows.length > 0 && STATION_TYPES.includes(rows[0].station_type)
    ? rows[0].station_type
    : null;
}

async function listStationFormDescs() {
  const rows = await db.query(
    'SELECT form_desc FROM crafting_stations WHERE enabled = 1 ORDER BY form_desc'
  );
  return rows.map((row) => row.form_desc).filter((value) => typeof value === 'string' && value.includes(':'));
}

async function registerPhysicalAnchors() {
  const anchors = typeof mp === 'undefined' || typeof mp.getIdFromDesc !== 'function'
    ? []
    : (await listStationFormDescs())
      .map((formDesc) => mp.getIdFromDesc(formDesc))
      .filter((targetId) => Number.isSafeInteger(targetId) && targetId > 0)
      .map((targetId) => ({ targetId }));
  physicalAnchorRegistry.register({
    targetType: interactionRegistry.TARGET_TYPES.OBJECT,
    list: async () => anchors
  });
  await physicalAnchorRegistry.refresh();
}

function registerInteractions() {
  const common = {
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.OBJECT,
    section: 'crafting',
    distance: serverOptions.get('crafting.maxDistance'),
    policyAction: 'craft',
    canSee: async (ctx) => Boolean(await resolveStation(ctx.target.formId))
  };

  interactionRegistry.register({
    ...common,
    id: 'crafting.recipes',
    label: 'View Recipes',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    execute: async (ctx) => {
      const stationType = await resolveStation(ctx.target.formId);
      if (!stationType) return { message: 'Station unavailable.' };
      const recipes = await listRecipes(ctx.actorId, stationType);
      return { message: recipes.length > 0 ? `${recipes.length} available recipe(s).` : 'No recipes available.' };
    }
  });

  interactionRegistry.register({
    ...common,
    id: 'crafting.craft',
    label: 'Craft Item',
    audit: interactionRegistry.AUDIT_LEVELS.ECONOMY,
    idempotent: true,
    schema: {
      recipeId: { type: 'int', label: 'Recipe', min: 1 },
      signatureText: { type: 'string', label: 'Dedication', max: 64, required: false }
    },
    execute: async (ctx) => {
      const stationType = await resolveStation(ctx.target.formId);
      if (!stationType) return { message: 'Station unavailable.' };
      const ok = await craftItem(ctx.actorId, ctx.characterId, ctx.data.recipeId, {
        stationType,
        signatureText: ctx.data.signatureText,
        requestId: ctx.requestId
      });
      return { message: ok ? 'Item crafted.' : 'Unable to craft the item.' };
    }
  });
}

/**
 * Lists the recipes available for a station type.
 */
async function listRecipes(actorId, stationType) {
  if (!STATION_TYPES.includes(stationType)) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Invalid station type.']);
    return [];
  }

  const recipes = await db.query(
    'SELECT id, name, result_base_id, result_count, requires_perk FROM crafting_recipes WHERE station_type = ?',
    [stationType]
  );

  if (recipes.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`No recipes available at ${stationType}.`]);
    return [];
  }

  const summary = recipes.map(r => `[${r.id}] ${r.name}`).join(' | ');
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [summary]);
  return recipes;
}

/**
 * Executes a craft. Player calls come from physical station interactions;
 * internal/test calls can still provide options directly.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number|string} recipeId
 * @param {object} [opts]
 * @param {string} [opts.stationType]    station type resolved from the physical target
 * @param {string} [opts.requestId]      idempotency key supplied by the requester
 * @param {string} [opts.signatureText]  dedication for the Maker's Mark
 *   (docs/design/MAKERS_MARK.md); only recorded if the recipe has a
 *   `required_profession` and the character's rank meets
 *   `crafting.signatureMinRank`. Silently ignored, without failing the craft,
 *   when the rank is insufficient.
 */
async function craftItem(actorId, characterId, recipeId, opts = {}) {
  // 1. Load the recipe
  const recipeRows = await db.query('SELECT * FROM crafting_recipes WHERE id = ?', [recipeId]);
  if (recipeRows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Recipe not found.']);
    return false;
  }
  const recipe = recipeRows[0];

  // 2. The station resolved from the physical target must match the recipe.
  // Distance is revalidated by the Interaction Framework before `execute`;
  // this second check prevents using a forge recipe at a valid tanning rack.
  if (opts.stationType && opts.stationType !== recipe.station_type) {
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
        `This recipe must be made at: ${recipe.station_type}.`
      ]);
    }
    return false;
  }

  // 2.5. Profession/rank gate — actually enforced, unlike `requires_perk`
  // (see this file's header). NULL = unrestricted access.
  if (recipe.required_profession) {
    const tem = await professionService.hasProfession(characterId, recipe.required_profession);
    if (!tem) {
      if (typeof mp !== 'undefined') {
        mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
          `You must be a ${recipe.required_profession} to do this.`
        ]);
      }
      return false;
    }
    if (recipe.required_rank !== null && recipe.required_rank !== undefined) {
      const estado = await professionService.getProfessionState(characterId, recipe.required_profession);
      if (!estado || estado.rank < recipe.required_rank) {
        if (typeof mp !== 'undefined') {
          mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
            `Your ${recipe.required_profession} rank is not high enough for this recipe.`
          ]);
        }
        return false;
      }
    }
  }

  // 3. Load the ingredients
  const ingredients = await db.query('SELECT base_id, count FROM crafting_ingredients WHERE recipe_id = ?', [recipeId]);
  if (ingredients.length === 0) {
    // A recipe without registered ingredients would create an item out of
    // nothing. `addRecipe` and `addIngredient` are separate commands, so
    // this window of opportunity is real — crafting during that window
    // would allow staff to accidentally create duplicate items.
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Incomplete recipe: no ingredients registered.']);
    return false;
  }

  // 4. The idempotency key.
  //
  // It previously contained `Date.now()`, which meant it never deduplicated
  // anything: two consecutive `/craft` requests produced two different keys,
  // the `UNIQUE` constraint was not violated, and the craft happened twice —
  // despite the comment claiming otherwise (audit §5).
  //
  // An idempotency key must come from THE REQUESTER, or from stable state.
  // Never from the clock of the process executing the request.
  const requestId = opts.requestId || inventory.newRequestId(`craft.${characterId}.${recipeId}`);

  // 5. Consume ingredients and deliver the result — ONE transaction.
  //
  // A separate inventory check is unnecessary: `applyStackDelta` reads
  // using `FOR UPDATE` and throws if there are insufficient items.
  // This is strictly better than the previous `hasItem` check, which read
  // outside the transaction. Between the check and consumption, an item
  // could have been removed through another path (market-stall sale,
  // staff `/removeitem`), and the craft would attempt to consume something
  // that no longer existed.
  //
  // Both legs name their `system` counterpart: the ingredient goes into
  // nothing, and the result comes from nothing.
  //
  // This ensures that the sum of the ledger deltas closes to zero by
  // `transfer_id`, and makes it possible to answer the audit question:
  // "Where did this item come from?" — a question that could not be
  // answered under audit §2.
  const resultado = await inventory.exchange({
    legs: [
      {
        from: inventory.character(characterId, actorId),
        to: inventory.system(inventory.SYSTEM_SOURCES.CONSUME),
        items: ingredients.map(ing => ({ baseId: ing.base_id, quantity: ing.count }))
      },
      {
        from: inventory.system(inventory.SYSTEM_SOURCES.CRAFT),
        to: inventory.character(characterId, actorId),
        items: [{ baseId: recipe.result_base_id, quantity: recipe.result_count }]
      }
    ],
    reason: 'craft',
    module: MODULE,
    requestId
  });

  if (!resultado.ok) {
    console.error(`[crafting] Craft failed (char=${characterId} recipe=${recipeId}): ${resultado.code} ${resultado.reason}`);
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Craft cancelled: ${resultado.reason}`]);
    }
    return false;
  }

  if (resultado.duplicate) {
    // A retry of the same request. It did not craft the item again, so
    // saying "you crafted it" would be misleading about an item the
    // player already has.
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['This craft had already been completed.']);
    }
    return true;
  }

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      `✓ You crafted: ${recipe.name} (x${recipe.result_count}).`
    ]);
  }

  // XP is awarded only when the recipe has an associated profession.
  // Free crafting does not advance any profession, for the same reason
  // `mining-service` only awards XP to `miner`.
  if (recipe.required_profession) {
    const xpPorCraft = serverOptions.get('crafting.xpPerCraft');
    if (xpPorCraft > 0) {
      await professionService.addProfessionXp({
        characterId,
        professionCode: recipe.required_profession,
        amount: xpPorCraft,
        context: 'craft'
      });
    }
  }

  // Maker's Mark — see this file's header and
  // docs/design/MAKERS_MARK.md.
  //
  // This only makes sense for recipes with an associated profession
  // (without `required_profession`, there is no profession whose rank
  // can be checked).
  if (recipe.required_profession && opts.signatureText) {
    const estado = await professionService.getProfessionState(characterId, recipe.required_profession);
    const minRank = serverOptions.get('crafting.signatureMinRank');
    if (estado && estado.rank >= minRank) {
      const texto = String(opts.signatureText).trim().slice(0, 64);
      await recordCraftSignature({
        baseId: recipe.result_base_id,
        recipeId: recipe.id,
        makerCharacterId: characterId,
        ownerCharacterId: characterId,
        signatureText: texto || null
      });
      if (typeof mp !== 'undefined') {
        mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['✓ Work signed.']);
      }
    } else if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
        `Your ${recipe.required_profession} rank is not high enough to sign this work.`
      ]);
    }
  }

  commands.broadcastProximityMessage(actorId, `* Works skillfully at the station.`, 500);
  console.log(`[crafting] Character ${characterId} crafted recipe ${recipeId}: ${recipe.name}`);
  return true;
}

/**
 * Staff: Adds a new recipe.
 * /addrecipe [station] [resultBaseId] [resultCount] [name]
 *
 * `requiredProfession` / `requiredRank` are optional — recipes without
 * these fields are available to any character, following the same default
 * behavior as `resource_nodes`.
 */
async function addRecipe(actorId, stationType, resultBaseId, resultCount, name, requiredProfession = null, requiredRank = null) {
  const adminService = require('./admin-service');
  if (!adminService.hasPermission(actorId, 'manage_recipes')) return null;

  const res = await db.query(
    `INSERT INTO crafting_recipes
      (name, station_type, result_base_id, result_count, required_profession, required_rank)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, stationType, resultBaseId, resultCount, requiredProfession, requiredRank]
  );
  const recipeId = res.insertId;

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Recipe created with ID ${recipeId}: ${name}`]);
  }
  console.log(`[crafting] Recipe ${recipeId} added by actor ${actorId.toString(16)}: ${name}`);
  return recipeId;
}

/**
 * Staff: Adds an ingredient to a recipe.
 * /addingredient [recipeId] [baseId] [count]
 */
async function addIngredient(actorId, recipeId, baseId, count) {
  const adminService = require('./admin-service');
  if (!adminService.hasPermission(actorId, 'manage_recipes')) return;

  await db.query(
    'INSERT INTO crafting_ingredients (recipe_id, base_id, count) VALUES (?, ?, ?)',
    [recipeId, baseId, count]
  );
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Ingredient 0x${baseId.toString(16)} x${count} added to recipe ${recipeId}.`]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signatures for the Institutional Journal — follows the same pattern as
// `crime-service.getStolenInstancesHeldBy`: resolve the crafter's name here,
// never return a raw characterId for the UI to format.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns signatures for items received by `characterId` through crafting,
 * with the crafter's name already resolved.
 *
 * See the caveat in this file's header and in
 * `migration-v24-crafted-item-signatures.sql`:
 * `owner_character_id` is not updated during trades/sales, so this reflects
 * who RECEIVED the item when it was crafted, not necessarily who owns it now.
 *
 * @param {number} characterId
 * @returns {Promise<Array<{baseId:number, signatureText:string|null, makerName:string}>>}
 */
async function getSignaturesHeldBy(characterId) {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return [];

  const rows = await db.query(
    `SELECT cis.base_id, cis.signature_text, c.first_name, c.last_name
       FROM crafted_item_signatures cis
       JOIN characters c ON c.id = cis.maker_character_id
      WHERE cis.owner_character_id = ?
      ORDER BY cis.crafted_at DESC
      LIMIT 20`,
    [characterId]
  );

  return rows.map((row) => ({
    baseId: Number(row.base_id),
    signatureText: row.signature_text || null,
    makerName: `${row.first_name} ${row.last_name}`.trim()
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Administrative commands. Player crafting only goes through physical
// station interactions; the old `/craft` and `/receitas` commands bypassed
// proximity validation.
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: '/addrecipe',
      description: '[Staff] Creates a recipe (optionally restricted to a profession/rank)',
      usage: '/addrecipe <station> <resultBaseId> <resultCount> <name> [profession] [rank]',
      handler: async (actorId, args) => {
        const partes = String(args || '').trim().split(/\s+/);
        const [stationType, resultBaseIdRaw, resultCountRaw, ...resto] = partes;
        const resultBaseId = Number.parseInt(resultBaseIdRaw, 16);
        const resultCount = Number.parseInt(resultCountRaw, 10);
        if (!STATION_TYPES.includes(stationType) || !Number.isSafeInteger(resultBaseId) || !Number.isSafeInteger(resultCount) || resto.length === 0) {
          if (typeof mp !== 'undefined') {
            mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
              'Usage: /addrecipe <station> <resultBaseId hex> <resultCount> <name> [profession] [rank]'
            ]);
          }
          return;
        }
        // The name may contain spaces; profession/rank, if provided, are
        // the final two words — an acceptable heuristic because a recipe
        // name does not end with an isolated numeric rank.
        let name = resto.join(' ');
        let requiredProfession = null;
        let requiredRank = null;
        const possivelRank = Number.parseInt(resto[resto.length - 1], 10);
        if (resto.length >= 2 && Number.isSafeInteger(possivelRank)) {
          requiredRank = possivelRank;
          requiredProfession = resto[resto.length - 2];
          name = resto.slice(0, -2).join(' ');
        }
        if (!name) name = resto.join(' ');

        await addRecipe(actorId, stationType, resultBaseId, resultCount, name, requiredProfession, requiredRank);
      }
    },
    {
      name: '/addingredient',
      description: '[Staff] Adds an ingredient to a recipe',
      usage: '/addingredient <recipeId> <baseId> <count>',
      handler: async (actorId, args) => {
        const [recipeIdRaw, baseIdRaw, countRaw] = String(args || '').trim().split(/\s+/);
        const recipeId = Number.parseInt(recipeIdRaw, 10);
        const baseId = Number.parseInt(baseIdRaw, 16);
        const count = Number.parseInt(countRaw, 10);
        if (!Number.isSafeInteger(recipeId) || !Number.isSafeInteger(baseId) || !Number.isSafeInteger(count)) {
          if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Usage: /addingredient <recipeId> <baseId hex> <count>']);
          return;
        }
        await addIngredient(actorId, recipeId, baseId, count);
      }
    }
  ];
}

module.exports = {
  listRecipes,
  craftItem,
  addRecipe,
  addIngredient,
  getSignaturesHeldBy,
  resolveStation,
  listStationFormDescs,
  registerPhysicalAnchors,
  registerInteractions,
  commandDefs,
  STATION_TYPES
};
