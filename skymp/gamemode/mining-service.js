/**
 * mining-service.js
 *
 * **Miner MVP.** The first real consumer of the Profession Core and the
 * Resource Node Framework — and the first module in the project to register an
 * `object`-target interaction in `core/interaction-registry.js`.
 *
 * ─── How the distance check stopped being a gap ─────────────────────────────
 *
 * The first version of this file had `/minerar <formDesc>` as a chat
 * command: the player typed the FormDesc by hand, and nothing checked whether they were
 * close to the vein. That command did not exist by accident — it was the simplest
 * way to deliver profession + tool + atomic delivery + XP,
 * leaving distance documented as a blocking gap until this module could
 * use the Interaction Framework (`docs/gameplay/MINING.md` §1, previous version).
 *
 * The fix was not "add a distance check" — it was swapping the wrong
 * interface for the right one. `core/interaction-targets.js` now resolves
 * `object` targets: the CLIENT reports the FormId of what it is aiming at (not a
 * typed string), `core/interaction-service.js` measures distance with
 * `target.assertRange` (the same generic mechanism that already protected `player`)
 * BEFORE `execute` runs, and only resolves the action if the vein is within
 * `mining.maxDistance`.
 *
 * ⚠️ **`mp.get(formId, 'locationalData')` against an ordinary `MpObjectReference`
 * is [DOC] in `types/mp.d.ts`, but it has never been validated in game by this
 * project** (decision made with the user: trust the official documentation and
 * implement, marking it as assumed). Validate manually on a real server
 * before taking `ENABLE_MINING_SERVICE` out of off-by-default.
 *
 * ─── What IS real here ──────────────────────────────────────────────────────
 *
 * - Distance via the Interaction Framework (`mining.maxDistance`, see above).
 * - The menu only shows "Mine" if the aimed FormId has an active row in
 *   `resource_nodes` (`canSee`) — but what really decides is always
 *   `resource-node-service.consume()`, revalidated in `execute`.
 * - Checks the tool (pickaxe) via `Actor.GetItemCount` — client-trusted only
 *   to decide whether the action STARTS, never what the player receives (same
 *   caveat `jobs-service.js` already documented for the woodcutter's axe).
 * - Ore delivery is 100% `resource-node-service.consume()`, which is already
 *   atomic with the node decrement (no item is born outside the DB). The
 *   profession/rank gate is also its job — not duplicated here.
 * - Anti-spam by `characterId` (not `actorId`, which is a recyclable slot) — same
 *   pattern as `jobs-service.activeGatherers`.
 */

'use strict';

const professionService = require('./profession-service');
const resourceNodeService = require('./resource-node-service');
const serverOptions = require('./core/server-options');
const interactionRegistry = require('./core/interaction-registry');
const physicalAnchorRegistry = require('./core/physical-anchor-registry');
const { actorRef } = require('./core/papyrus');

const MODULE = 'mining';
const PROFESSION_CODE = 'miner';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime diagnostics — ENABLE_MINING_RUNTIME_DIAGNOSTICS
//
// Exists only for the acceptance testing recorded in
// docs/research/MINING_RUNTIME_VALIDATION_REPORT.md: correlating, with a
// single log line per stage, what the client reported as the target, what
// `mp.get(formId,'locationalData')` really returned on a real server, the
// result of the tool check and the result of `consume()` — without
// having to instrument each file during the manual test.
//
// Same flag pattern as the rest of the project (`process.env.X === 'true'`, see
// `voip-service.js` and `VOIP_DEBUG_EXPOSE_TICKET`). Off by default: like
// every `lab` module, this must not run in production — it is test scaffolding, not
// gameplay. It changes NO `canSee`/`execute` result; it only observes.
//
// `correlationId` groups the lines of a single mining attempt: generated
// once per `execute()`, carried in every `_diag()` of that call. It does not
// log the player's position/coordinates as text (only the target's, which is public —
// a mining vein is not sensitive character data).
function _diagnosticsEnabled() {
  return process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS === 'true';
}

function _diag(correlationId, stage, payload) {
  if (!_diagnosticsEnabled()) return;
  console.log(`[mining:diag] ${correlationId} ${stage} ${JSON.stringify(payload)}`);
}

function _newCorrelationId(characterId) {
  return `mine-${characterId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Same FormID jobs-service.js (PARKED) already used — vetted in that
// round, not reinvented here.
const ITEM_PICKAXE = 0x000e3c16;

/**
 * Keyed by `characterId`, never by `actorId` — SkyMP reuses
 * `actorId` across sessions, and the wrong key has already produced a real bug in this
 * project (see the equivalent comment in `jobs-service.js` and in
 * `commands.js:activeCharacters`).
 * @type {Set<number>}
 */
const activeGatherers = new Set();

const FAILURE_MESSAGES = Object.freeze({
  depleted: 'This vein is depleted. Come back later.',
  node_disabled: 'This vein is not available.',
  not_found: 'There is nothing to mine here.',
  profession_required: 'You need to be a Miner to do that.',
  rank_too_low: 'Your Miner rank is not high enough for this vein yet.',
  invalid_character: 'Invalid character.',
  invalid_form_desc: 'Invalid target.',
  invalid_request_id: 'Invalid attempt.',
  cooldown: 'This vein is still recovering for you.'
});

/**
 * `mp.getDescFromId` is [USO] but it is already this gamemode's standard way of
 * converting FormId→FormDesc (see `core/papyrus.js`); without `mp`, there is no way to
 * know the FormDesc, and the caller treats `null` as "not a vein".
 * @param {number} formId
 * @returns {string|null}
 */
function _formDescOf(formId) {
  if (typeof mp === 'undefined') return null;
  return mp.getDescFromId(formId);
}

/**
 * @param {number} formId
 * @returns {Promise<object|null>}
 */
async function _nodeAt(formId) {
  const formDesc = _formDescOf(formId);
  if (!formDesc) return null;
  return resourceNodeService.getNode(formDesc);
}

/**
 * Client-trusted only to decide whether the action STARTS — what the player receives is
 * entirely decided by `resource-node-service.consume()`, in the DB.
 * @param {number} actorId
 * @returns {boolean}
 */
function _hasPickaxe(actorId) {
  if (typeof mp === 'undefined') return true;
  const count = mp.callPapyrusFunction('method', 'Actor', 'GetItemCount', actorRef(actorId), [ITEM_PICKAXE]);
  return count > 0;
}

/**
 * Registers `mining.mine` in the Interaction Framework. Called from the module's
 * `initialize()` — it needs the framework ready, hence `dependencies: ['interaction']`
 * in `phase0-basic.js`.
 */
function registerMiningInteractions() {
  interactionRegistry.register({
    id: 'mining.mine',
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.OBJECT,
    label: 'Mine',
    // The vein's physical range, measured by the server via `target.assertRange`
    // before `execute` runs — this is what closes the distance gap.
    distance: serverOptions.get('mining.maxDistance'),
    idempotent: true,
    audit: interactionRegistry.AUDIT_LEVELS.ECONOMY,
    policyAction: 'mining',
    // Only shows up in the menu if the aimed FormId really is an active vein. What
    // really decides is still `consume()`, revalidated below.
    canSee: async ctx => {
      const no = await _nodeAt(ctx.target.formId);
      if (_diagnosticsEnabled()) {
        _diag('n/a', 'target_received', { formId: `0x${ctx.target.formId.toString(16)}`, targetType: ctx.target.type });
        _diag('n/a', 'target_resolved', { nodeFound: Boolean(no), rawNode: no || null });
      }
      return Boolean(no);
    },
    execute: async ctx => {
      const correlationId = _newCorrelationId(ctx.characterId);
      _diag(correlationId, 'execute_start', {
        characterId: ctx.characterId,
        actorId: `0x${ctx.actorId.toString(16)}`,
        targetFormId: `0x${ctx.target.formId.toString(16)}`,
        requestId: ctx.requestId || null
      });

      if (activeGatherers.has(ctx.characterId)) {
        _diag(correlationId, 'blocked_concurrent', {});
        return { message: 'You are already busy doing something.' };
      }

      const temPicareta = _hasPickaxe(ctx.actorId);
      _diag(correlationId, 'tool_check', { hasPickaxe: temPicareta, source: 'Actor.GetItemCount (client-trusted, only decides the start)' });
      if (!temPicareta) {
        return { message: 'You need a pickaxe.' };
      }

      const formDesc = _formDescOf(ctx.target.formId);
      _diag(correlationId, 'form_desc_resolved', { formDesc });
      if (!formDesc) return { message: FAILURE_MESSAGES.not_found };

      activeGatherers.add(ctx.characterId);
      try {
        const resultado = await resourceNodeService.consume({
          characterId: ctx.characterId,
          actorId: ctx.actorId,
          formDesc,
          requestId: ctx.requestId,
          cooldownMs: serverOptions.get('mining.cooldownMs')
        });
        _diag(correlationId, 'resource_node_consume', { ok: resultado.ok, code: resultado.code || null, data: resultado.data || null });

        if (!resultado.ok) {
          return { message: FAILURE_MESSAGES[resultado.code] || 'Could not mine right now.' };
        }

        if (resultado.replay) {
          return { message: 'This mining attempt was already processed.', data: resultado.data };
        }

        const xpPorColeta = serverOptions.get('mining.xpPerGather');
        if (xpPorColeta > 0) {
          await professionService.addProfessionXp({
            characterId: ctx.characterId,
            professionCode: PROFESSION_CODE,
            amount: xpPorColeta,
            context: 'mining_gather'
          });
          _diag(correlationId, 'profession_xp_granted', { professionCode: PROFESSION_CODE, amount: xpPorColeta });
        }

        return {
          message: `You mined ${resultado.data.yield}x (${resultado.data.capacity}/${resultado.data.maxCapacity} left in the vein).`,
          data: resultado.data
        };
      } finally {
        activeGatherers.delete(ctx.characterId);
        _diag(correlationId, 'execute_end', {});
      }
    }
  });
}

async function registerPhysicalAnchors() {
  const anchors = typeof mp === 'undefined' || typeof mp.getIdFromDesc !== 'function'
    ? []
    : (await resourceNodeService.listEnabledNodes())
      .map(formDesc => mp.getIdFromDesc(formDesc))
      .filter(targetId => Number.isSafeInteger(targetId) && targetId > 0)
      .map(targetId => ({ targetId }));
  physicalAnchorRegistry.register({
    targetType: interactionRegistry.TARGET_TYPES.OBJECT,
    list: async () => anchors
  });
  await physicalAnchorRegistry.refresh();
}

/**
 * Checks, through real reflection of the server's Papyrus VM (`mp._sp3ListMethods`,
 * `[UPSTREAM CODE]` `ScampServer::SP3ListMethods` → `GetPapyrusVm().ListMethods`),
 * whether `GetItemCount` is registered on the classes `_hasPickaxe` calls.
 *
 * It exists to answer in milliseconds, without needing a connected player
 * or a manual test, the question that
 * `docs/research/SKYMP_INTEGRATION_AUDIT.md` (finding #5, `BOUND-006`)
 * left open: is `Actor.GetItemCount` really available on this
 * server, the way it is configured today (empty `archives`,
 * `skymp/server/data/scripts/` without `Actor.pex`)? This distinguishes
 * **PAPYRUS FUNCTION NOT AVAILABLE** (the class/method is not in the VM — it is an
 * archive configuration matter, solved by loading the `.pex`) from
 * **PAPYRUS FUNCTION AVAILABLE BUT CALL FAILED** (the method exists, the problem
 * is something else — wrong argument, invalid `self`, etc.) — both produce the
 * same symptom for whoever only looks at `_hasPickaxe`'s result, but call for a
 * completely different fix.
 *
 * It only runs with the diagnostics flag on — it is reflection, not gameplay, and
 * `_sp3*` only exists on a real server (without `mp`, there is nothing to check).
 */
function _diagnoseItemCountAvailability() {
  if (!_diagnosticsEnabled()) return;
  if (typeof mp === 'undefined' || typeof mp._sp3ListMethods !== 'function') {
    _diag('boot', 'itemcount_availability_check_skipped', { reason: 'mp._sp3ListMethods unavailable (no real mp, or a SkyMP version without _sp3 introspection)' });
    return;
  }
  for (const className of ['Actor', 'ObjectReference']) {
    try {
      const methods = mp._sp3ListMethods(className) || [];
      const registrado = methods.includes('GetItemCount');
      _diag('boot', 'itemcount_availability_check', { className, registrado, totalMetodos: methods.length });
    } catch (err) {
      _diag('boot', 'itemcount_availability_check_error', { className, error: err.message });
    }
  }
}

async function initMiningService() {
  registerMiningInteractions();
  await registerPhysicalAnchors();
  _diagnoseItemCountAvailability();
}

/** Mirrors the pattern of `market-stalls-service.shutdownMarketStallsService`. */
function shutdownMiningService() {
  interactionRegistry.unregisterModule(MODULE);
}

module.exports = {
  MODULE,
  PROFESSION_CODE,
  ITEM_PICKAXE,
  initMiningService,
  shutdownMiningService,
  registerMiningInteractions,
  registerPhysicalAnchors,
  FAILURE_MESSAGES,
  // Exposed only for tests.
  activeGatherers,
  _diagnoseItemCountAvailability
};
