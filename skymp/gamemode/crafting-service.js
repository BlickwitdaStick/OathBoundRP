/**
 * crafting-service.js
 * Modular Crafting System (Beta Phase).
 *
 * Works 100% server-side:
 * - The client sends the intent through the `[E]` interaction of a registered station.
 * - The server consumes the ingredients and delivers the result in a single transaction.
 *
 * ⚠️ **What this header claimed that was not true.** Until 2026-08-13 this
 * list said *"the server validates ingredients, station proximity and perks"*.
 * Ingredients yes, through `FOR UPDATE`. **Station proximity: never** — the
 * `craftItem` did not even load the station, so `/craft` worked from the other
 * side of the map. **Perk: never** — `requires_perk` is read in `listRecipes` and
 * never compared against anything.
 *
 * Since migration v28, player input goes exclusively through the
 * Interaction Framework: the server resolves the FormDesc in
 * `crafting_stations`, validates the physical distance and derives the `station_type`.
 * `requires_perk` is still deliberately unused; profession/rank is the gate
 * adopted. See `docs/gameplay/CRAFTING_SYSTEM.md`.
 *
 * Registered in `core/module-registry.js` as the `crafting` module (phase `lab`,
 * `ENABLE_CRAFTING_SERVICE`, off by default). The migration below was an
 * internal safety fix and was kept separate from the decision to reactivate on purpose — mixing
 * the two is the mistake Phase 2 of the QA_REPORT exists to avoid repeating.
 * See docs/technical/PARKED_SERVICES_DECISION.md §7.2 for the history.
 *
 * ─── Profession gate (2026-08-20) ───────────────────────────────────────────
 *
 * `crafting_recipes.required_profession`/`required_rank`
 * (migration-v23-crafting-profession-gate.sql) são checados dentro de
 * `craftItem()`, with the same design `resource_nodes.required_profession` already
 * uses against `profession-service.js`. NULL stays open to any
 * character — no recipe has the field filled in today, so this does not
 * change behavior by itself; it is staff who can now tie a recipe
 * to `blacksmith`, `smelter`, `tanner`, `enchanter` or `cook` via `/addrecipe`.
 * `requires_perk` is still unused — it is not the field this gate reads.
 *
 * ─── Maker's Mark (2026-08-22) ──────────────────────────────────────────────
 *
 * See docs/design/MAKERS_MARK.md. A crafter with rank >=
 * `crafting.signatureMinRank` can record a dedication in
 * `crafted_item_signatures` (migration-v24) when crafting a recipe tied to a
 * profession. **It is not the same transaction as `inventory.exchange`** — a
 * deliberate decision, not an oversight: `exchange()` (core/inventory.js) exposes no hook
 * for external writes, and extending that file (used by trade/depot/
 * market-stall/crafting) just for this feature would be a risk out of proportion
 * to the gain. The signature is flavor metadata — it moves neither gold nor items — so
 * an isolated failure in the `INSERT` only ends up in the log, with no exploit and no loss of
 * wealth, unlike what would apply to a real item transfer
 * (see `recordCraftSignature` below).
 *
 * ─── Why this file changed ──────────────────────────────────────────────────
 *
 * `craftItem` announced `// 4. Consumes ingredients (safe transaction: all
 * or nothing)` and was neither of those things. It was a loop of
 * independent `inventoryService.removeItem()` calls followed by a `giveItem()`, and
 * each of those functions **opens its own transaction** in transaction-service.
 * A three-ingredient recipe was four separate transactions: if the
 * second one failed, the first had already committed, the player lost the
 * ingredient and received nothing.
 *
 * It is `economy-service.transfer` (`removeGold` followed by `addGold`, with no
 * transaction) with another noun — the same defect that led to deleting that
 * file, transposed from gold to items.
 *
 * Phase 3 (2026-08-07) put everything in a single transaction through the `tx.*` primitives. On
 * 2026-08-13 the same flow became **a single call** to
 * `core/inventory.exchange`, with two legs: consumption (character →
 * `system:consume`) and delivery (`system:craft` → character). The gain over the
 * previous version is not atomicity — that was already right — but that the
 * other side of each movement now has a name in the ledger, and that the
 * idempotency key stopped being useless (see step 4 of `craftItem`).
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
 * Records the Maker's Mark (docs/design/MAKERS_MARK.md). Called AFTER
 * `inventory.exchange` has already committed — it is not the same transaction (see the
 * header of this file). A failure here does not undo the craft: the player already
 * received the item, it just is not recorded who signed it.
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
    console.error(`[crafting] failed to record signature (recipe=${recipeId} maker=${makerCharacterId}):`, err.message);
  }
}

// Station types accepted in `crafting_stations` (real Skyrim objects).
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
    label: 'View recipes',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    execute: async (ctx) => {
      const stationType = await resolveStation(ctx.target.formId);
      if (!stationType) return { message: 'Station unavailable.' };
      const recipes = await listRecipes(ctx.actorId, stationType);
      return { message: recipes.length > 0 ? `${recipes.length} recipe(s) available.` : 'No recipes available.' };
    }
  });

  interactionRegistry.register({
    ...common,
    id: 'crafting.craft',
    label: 'Craft item',
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
      return { message: ok ? 'Item crafted.' : 'Could not craft the item.' };
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
 * Runs a craft. The player's call comes from the physical interaction; internal
 * calls/tests can still provide opts directly.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number|string} recipeId
 * @param {object} [opts]
 * @param {string} [opts.stationType]    station resolved by the server
 * @param {string} [opts.requestId]      idempotency key coming from whoever asked
 * @param {string} [opts.signatureText]  dedication for the Maker's Mark
 *   (docs/design/MAKERS_MARK.md); it is only recorded if the recipe has a
 *   `required_profession` and the character's rank reaches
 *   `crafting.signatureMinRank`. Silently ignored, without failing the
 *   craft, when the rank does not reach it.
 */
async function craftItem(actorId, characterId, recipeId, opts = {}) {
  // 1. Carrega a receita
  const recipeRows = await db.query('SELECT * FROM crafting_recipes WHERE id = ?', [recipeId]);
  if (recipeRows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Recipe not found.']);
    return false;
  }
  const recipe = recipeRows[0];

  // 2. The station resolved from the physical target must be the recipe's. Distance
  // is revalidated by the Interaction Framework before `execute`; this second
  // check prevents using a forge recipe on a valid tanning_rack.
  if (opts.stationType && opts.stationType !== recipe.station_type) {
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
        `This recipe is made at: ${recipe.station_type}.`
      ]);
    }
    return false;
  }

  // 2.5. Profession/rank gate — really checked, unlike
  // `requires_perk` (see this file's header). NULL = open recipe.
  if (recipe.required_profession) {
    const tem = await professionService.hasProfession(characterId, recipe.required_profession);
    if (!tem) {
      if (typeof mp !== 'undefined') {
        mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
          `You need to be a ${recipe.required_profession} to do that.`
        ]);
      }
      return false;
    }
    if (recipe.required_rank !== null && recipe.required_rank !== undefined) {
      const estado = await professionService.getProfessionState(characterId, recipe.required_profession);
      if (!estado || estado.rank < recipe.required_rank) {
        if (typeof mp !== 'undefined') {
          mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
            `Your ${recipe.required_profession} rank is not high enough for this recipe yet.`
          ]);
        }
        return false;
      }
    }
  }

  // 3. Load the ingredients
  const ingredients = await db.query('SELECT base_id, count FROM crafting_ingredients WHERE recipe_id = ?', [recipeId]);
  if (ingredients.length === 0) {
    // A recipe with no registered ingredient would create an item out of nothing. `addRecipe` and
    // `addIngredient` are two separate commands, so the window between them
    // really exists — and a craft in it would be item duplication by staff.
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Incomplete recipe: no ingredients registered.']);
    return false;
  }

  // 4. The idempotency key.
  //
  // It used to contain `Date.now()`, and so it never deduplicated anything: two consecutive `/craft`
  // calls produced two different keys, the `UNIQUE` was not violated and the
  // craft happened twice — while the comment there claimed the
  // opposite (audit §5). An idempotency key comes from WHOEVER ASKS, or
  // from a stable state. Never from the executor's clock.
  const requestId = opts.requestId || inventory.newRequestId(`craft.${characterId}.${recipeId}`);

  // 5. Consume ingredients and deliver the result — ONE transaction, two legs.
  //
  // The stock check needs no step of its own: `applyStackDelta` reads
  // with `FOR UPDATE` and throws if something is missing, which is strictly better than the
  // `hasItem` that existed before. That one read outside the transaction, so between the
  // check and the consumption the item could have left through another path (a stall
  // sale, staff's /removeitem) and the craft consumed what no longer existed.
  //
  // Both legs name `system` as the counterparty: the ingredient goes into the
  // void and the result comes from the void. That is what makes the sum of the ledger's deltas
  // close at zero per `transfer_id`, and what makes the question
  // "where did this item come from?", which audit §2 could not answer, answerable.
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
    console.error(`[crafting] Craft falhou (char=${characterId} recipe=${recipeId}): ${resultado.code} ${resultado.reason}`);
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Crafting cancelled: ${resultado.reason}`]);
    }
    return false;
  }

  if (resultado.duplicate) {
    // The same request resent. It did not craft again, and saying "you crafted" would be
    // lying about an item the player already has.
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['This craft was already completed.']);
    }
    return true;
  }

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      `✓ You crafted: ${recipe.name} (x${recipe.result_count}).`
    ]);
  }

  // XP only when the recipe has an owning profession — a free craft does not advance
  // any profession, for the same reason `mining-service` only grants `miner`
  // XP.
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
  // docs/design/MAKERS_MARK.md. It only makes sense for a recipe with an owner
  // (without `required_profession` there is no profession to check the rank against).
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
        `Your ${recipe.required_profession} rank does not allow you to sign this work yet.`
      ]);
    }
  }

  commands.broadcastProximityMessage(actorId, `* Works skillfully at the station.`, 500);
  console.log(`[crafting] Char ${characterId} crafted recipe ${recipeId}: ${recipe.name}`);
  return true;
}

/**
 * Staff: Adds a new recipe to the database.
 * /addrecipe [station] [resultBaseId] [resultCount] [name]
 *
 * `requiredProfession`/`requiredRank` are optional — a recipe without them is
 * open to any character, the same default as `resource_nodes`.
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
// Signatures for the Institutional Search — same pattern as
// `crime-service.getStolenInstancesHeldBy`: resolves the crafter's name here,
// never returns a raw characterId for the UI to format.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signatures of items `characterId` received when crafting, with the
 * crafter's name already resolved. See the caveat in this file's header and in
 * `migration-v24-crafted-item-signatures.sql`: `owner_character_id` is not
 * updated on trade/sale, so this reflects who RECEIVED it in the craft, not
 * necessarily who has the item now.
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
// Administrative commands. Player crafting only goes through the interaction at a
// physical station; the old `/craft` and `/receitas` bypassed proximity.
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: '/addrecipe',
      description: '[Staff] Creates a recipe (optionally tied to a profession/rank)',
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
        // The name can have spaces; profession/rank, if present, are the last two
        // words — an acceptable heuristic because a recipe name does not
        // end with an isolated numeric rank.
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
      usage: '/addingredient <recipeId> <baseId hex> <count>',
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
