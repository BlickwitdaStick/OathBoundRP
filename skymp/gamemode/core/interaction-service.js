/**
 * core/interaction-service.js
 *
 * The pipeline that separates "the client asked" from "the server did".
 *
 * ─── Flow, in order, and why this order ─────────────────────────────────────
 *
 *   envelope → rate limit → known action → target → schema → permission
 *            → action policy (state + zone) → distance
 *            → canSee → canExecute → deduplication → execute → audit
 *
 * The order is not decorative. Each stage is more expensive than the previous one, and each
 * only receives input the previous one already cleaned:
 *
 *   - **rate limit before everything** because its whole point is not paying for the rest;
 *   - **target before schema** because a request with no valid target has nothing
 *     to validate the payload against, and because resolving the target is what turns the
 *     client's `targetId` into the record the server already had;
 *   - **permission before policy** because "you are not a guard" is a better answer
 *     than "you are restrained" for someone who is not a guard;
 *   - **policy and distance before `canSee`** because both are core rules
 *     and `canSee` is module code: the cheap and auditable runs first;
 *   - **deduplication after all validation** because a request that was going to be
 *     refused must not consume the `requestId` — otherwise the legitimate, already
 *     corrected retry would be refused as a duplicate.
 *
 * ─── The rule this file exists to enforce ───────────────────────────────────
 *
 * **`canSee` authorizes nothing.** It decides what shows up in a menu that was
 * built at an earlier instant, on someone else's machine. Between building it and
 * the click the target may have moved, left, been arrested or sold the stall; the
 * player may have lost their post. That is why `execute` **reruns the whole
 * pipeline** — resolves the target again, checks permission again, measures distance
 * again — and runs `canExecute` in addition to `canSee`.
 *
 * That is §11 of the request, and it was already governance's behavior by
 * accident of design (the domain functions revalidate on their own). Here it becomes a
 * contract: no interaction needs to remember to revalidate, because the one that
 * revalidates is the pipeline.
 *
 * ─── What remains the responsibility of whoever registers ───────────────────
 *
 * Atomicity. An `execute` that moves gold and items calls
 * `core/transaction-service.js` — this file opens no transaction and does not know what
 * gold is. The pipeline guarantees the call is legitimate;
 * `transaction-service` guarantees it is atomic and auditable.
 */

const { AUDIT_LEVELS } = require('./interaction-registry');

/** Stages, in order. Used in the result and in tests. */
const STAGES = Object.freeze({
  ENVELOPE: 'envelope',
  RATE_LIMIT: 'rate_limit',
  UNKNOWN_ACTION: 'unknown_action',
  TARGET: 'target',
  SCHEMA: 'schema',
  PERMISSION: 'permission',
  POLICY: 'policy',
  DISTANCE: 'distance',
  CAN_SEE: 'can_see',
  CAN_EXECUTE: 'can_execute',
  DUPLICATE: 'duplicate',
  EXECUTE: 'execute',
  DONE: 'done'
});

const DEFAULT_DEDUP_TTL_MS = 120_000;
const MIN_REQUEST_ID_LENGTH = 8;
const MAX_REQUEST_ID_LENGTH = 48;

/** A single message for everything the player should not be able to tell apart. */
const RECUSA_GENERICA = 'Action unavailable.';

// Display names for interaction-menu sections. The section id stays the
// internal key; only the label sent to the CEF is translated.
const SECTION_LABELS = Object.freeze({
  self: 'You',
  social: 'Social',
  guarda: 'Guard',
  barraca: 'Stall',
  deposito: 'Depot',
  crime: 'Crime',
  crafting: 'Crafting'
});

/**
 * Normalizes the return value of `canSee`/`canExecute`.
 * Accepts `true`, `false`, `{allowed}` and `{allowed, reason}` — the three shapes a
 * module naturally writes.
 * @param {unknown} raw
 * @returns {{allowed: boolean, reason: string}}
 */
function normalizeVerdict(raw) {
  if (raw === true) return { allowed: true, reason: '' };
  if (raw === false || raw === undefined || raw === null) {
    return { allowed: false, reason: '' };
  }
  if (typeof raw === 'object') {
    const v = /** @type {any} */ (raw);
    return { allowed: Boolean(v.allowed), reason: typeof v.reason === 'string' ? v.reason : '' };
  }
  return { allowed: Boolean(raw), reason: '' };
}

/**
 * @param {object} deps
 * @param {object} deps.registry        - `core/interaction-registry`
 * @param {{resolve: Function}} deps.targets - from `createTargetResolvers`
 * @param {(actorId: number) => object|null|undefined} deps.getCharacter
 * @param {(actorId: number, permission: string, ctx: object) => Promise<{allowed: boolean, reason?: string}>} [deps.checkPermission]
 * @param {{canPerform: Function}} [deps.actionPolicy]
 * @param {{observe: Function}} [deps.rateLimiter]
 * @param {(entry: object) => void|Promise<void>} [deps.audit]
 * @param {(actorId: number, message: string) => void} [deps.notify]
 * @param {(actorId: number, type: string, data: object) => void} [deps.sendModal]
 * @param {() => number} [deps.now]
 * @param {number} [deps.dedupTtlMs]
 * @param {Pick<Console,'log'|'warn'|'error'>} [deps.logger]
 */
function createInteractionService({
  registry,
  targets,
  getCharacter,
  checkPermission,
  actionPolicy,
  rateLimiter,
  audit,
  notify = () => {},
  sendModal = () => {},
  now = Date.now,
  dedupTtlMs = DEFAULT_DEDUP_TTL_MS,
  logger = console
}) {
  if (!registry || typeof registry.get !== 'function' || typeof registry.listForTarget !== 'function') {
    throw new Error('[interaction-service] invalid registry');
  }
  if (!targets || typeof targets.resolve !== 'function') {
    throw new Error('[interaction-service] invalid targets');
  }
  if (typeof getCharacter !== 'function') {
    throw new Error('[interaction-service] invalid getCharacter');
  }

  /**
   * Requests already seen, by `${actorId}:${requestId}`.
   *
   * Stores the **result**, not just the mark. A double click must not become two
   * fines, and must not become a fine and an error either: the second call
   * returns what the first one returned, which is what the player expects to see.
   *
   * Kept in memory on purpose. A table would give idempotency across server
   * restarts, and the cost would be an `INSERT` on the hot path of every
   * interaction — to protect against a case (a double click spanning a restart)
   * that does not happen. The idempotency that **must** survive a restart already
   * exists one layer below, through `idempotency_key` in `transaction-service`, and
   * that is what protects gold and items. This one protects against double clicks.
   *
   * @type {Map<string, {state: 'running'|'done', at: number, result?: object}>}
   */
  const seen = new Map();

  function sweepDedup(timestamp) {
    for (const [key, entry] of seen.entries()) {
      if (timestamp - entry.at >= dedupTtlMs) seen.delete(key);
    }
  }

  /**
   * @param {string} stage
   * @param {string} reason
   * @returns {{ok: false, stage: string, reason: string}}
   */
  function fail(stage, reason) {
    return { ok: false, stage, reason };
  }

  /**
   * Stages 1 to 8 — everything that applies equally to querying and to executing.
   *
   * Returns the ready context (§12 of the request) or the refusal with the stage where
   * it happened. `execute` calls this again, from scratch: that is what guarantees
   * an option seen thirty seconds ago is worth nothing by itself.
   *
   * @param {number} actorId
   * @param {object} entry            interaction descriptor
   * @param {unknown} rawTargetId
   * @param {unknown} rawPayload
   * @param {{skipSchema?: boolean}} [options]
   */
  async function buildContext(actorId, entry, rawTargetId, rawPayload, options = {}) {
    const actor = getCharacter(actorId);
    if (!actor) return fail(STAGES.TARGET, 'Character not loaded.');

    // ── Target ──────────────────────────────────────────────────────────────
    // Redone on every call, and this is where the target disconnecting between the query
    // and the click becomes a clean refusal: `getCharacter` no longer answers for
    // whoever left, so the target does not resolve.
    const resolved = targets.resolve(entry.target, rawTargetId, actorId);
    if (!resolved.ok) return fail(STAGES.TARGET, resolved.reason);
    const target = resolved.target;

    // ── Schema ──────────────────────────────────────────────────────────────
    let data = {};
    if (!options.skipSchema) {
      const validated = registry.validatePayload(entry.schema, rawPayload);
      if (!validated.ok) return fail(STAGES.SCHEMA, validated.reason);
      data = validated.data;
    }

    // ── Permission ──────────────────────────────────────────────────────────
    // The permission is an opaque string to this file. Whoever knows what
    // `guard.search` means is the adapter the module injects — governance
    // checks the post in `governance_memberships`, staff checks
    // `admin-service`. The core does not choose a permission model for the modules.
    let permission = null;
    if (entry.permission) {
      if (typeof checkPermission !== 'function') {
        logger.error(
          `[interaction-service] '${entry.id}' requires the permission '${entry.permission}' ` +
          `and no checkPermission was injected. Denying.`
        );
        return fail(STAGES.PERMISSION, RECUSA_GENERICA);
      }
      const verdict = await checkPermission(actorId, entry.permission, { target, interactionId: entry.id });
      const normalized = normalizeVerdict(verdict);
      if (!normalized.allowed) {
        return fail(STAGES.PERMISSION, normalized.reason || 'You are not authorized to do that.');
      }
      permission = normalized;
    }

    // ── Action policy: character state + zone ──────────────────────────────
    if (entry.policyAction && actionPolicy) {
      const context = { actorId };
      if (target.actorId !== undefined) context.targetActorId = target.actorId;
      const verdict = actionPolicy.canPerform(actor.characterId, entry.policyAction, context);
      if (!verdict.allowed) return fail(STAGES.POLICY, verdict.reason);
    }

    // ── Distance ────────────────────────────────────────────────────────────
    // `unverified` tells "we measured and it is close" apart from "there was no way to measure"
    // (`mp` missing — see CORE_FRAMEWORK_AUDIT.md §5). The pipeline lets it through
    // in both cases, as it always did, but only the first becomes "validated" in the
    // audit log.
    let distanceVerified = false;
    let distanceUnverified = false;
    if (entry.distance !== null && typeof target.assertRange === 'function') {
      const verdict = target.assertRange(actorId, entry.distance);
      if (!verdict.ok) return fail(STAGES.DISTANCE, verdict.reason || 'Target out of range.');
      distanceUnverified = Boolean(verdict.unverified);
      distanceVerified = !distanceUnverified;
    }

    return {
      ok: true,
      ctx: {
        actorId,
        actor,
        characterId: actor.characterId,
        accountId: actor.accountId || null,
        target,
        interactionId: entry.id,
        module: entry.module,
        data,
        permission,
        distanceVerified,
        distanceUnverified,
        requestId: null
      }
    };
  }

  /**
   * Runs `canSee` (and, when asked, `canExecute`) with the ready context.
   *
   * A `canSee` that **throws** does not become "can": it becomes "cannot", with a log. A
   * buggy module must not open anyone's menu.
   */
  async function runGuard(entry, ctx, which) {
    const guard = entry[which];
    if (!guard) return { allowed: true, reason: '' };
    try {
      return normalizeVerdict(await guard(ctx));
    } catch (err) {
      logger.error(`[interaction-service] ${which} of '${entry.id}' threw:`, err.message);
      return { allowed: false, reason: RECUSA_GENERICA };
    }
  }

  function checkRate(actorId, kind) {
    if (!rateLimiter) return true;
    const verdict = rateLimiter.observe(actorId, `interaction:${kind}`);
    return Boolean(verdict && verdict.allowed);
  }

  async function record(entry, ctx, outcome, detail) {
    if (entry.audit === AUDIT_LEVELS.TRACE || typeof audit !== 'function') return;
    try {
      await audit({
        level: entry.audit,
        interactionId: entry.id,
        module: entry.module,
        actorId: ctx.actorId,
        accountId: ctx.accountId,
        target: { type: ctx.target.type, id: ctx.target.id, accountId: ctx.target.accountId || null },
        outcome,
        detail: detail || null,
        distanceVerified: ctx.distanceVerified,
        requestId: ctx.requestId
      });
    } catch (err) {
      // An audit that fails does not undo the action: it already happened. Scream and move on.
      logger.error(`[interaction-service] audit of '${entry.id}' failed:`, err.message);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * What this actor can see in this target's menu, right now.
   *
   * Returns **only label, id and form fields**. Never the permission that
   * allowed the action, nor why the others disappeared: the list of
   * actions is the answer, and the reasoning belongs to the server.
   *
   * @param {number} actorId
   * @param {{targetType?: unknown, targetId?: unknown}} request
   */
  async function query(actorId, request) {
    if (!request || typeof request !== 'object') {
      return fail(STAGES.ENVELOPE, 'Invalid request.');
    }
    if (!checkRate(actorId, 'query')) {
      return fail(STAGES.RATE_LIMIT, 'Wait a moment.');
    }
    return _computeSections(actorId, request);
  }

  /**
   * The same computation as `query`, without the rate limit.
   *
   * Exclusively for an INTERNAL server caller (e.g. a periodic tick that
   * decides whether to show the `[E]` prompt — Task 11), never for an event coming from the
   * CEF. The CEF's `interaction:query` always goes through `query()`, with the limit;
   * wiring this into a `ui-event-router` would open a second door to the same
   * computation without the brake the first one has.
   *
   * @param {number} actorId
   * @param {{targetType?: unknown, targetId?: unknown}} request
   */
  async function peek(actorId, request) {
    if (!request || typeof request !== 'object') {
      return fail(STAGES.ENVELOPE, 'Invalid request.');
    }
    return _computeSections(actorId, request);
  }

  async function _computeSections(actorId, request) {
    const targetType = typeof request.targetType === 'string' ? request.targetType : null;
    if (!targetType) return fail(STAGES.ENVELOPE, 'Missing target type.');

    const candidates = registry.listForTarget(targetType);
    if (candidates.length === 0) {
      return { ok: true, stage: STAGES.DONE, targetType, target: null, sections: [] };
    }

    /** @type {Map<string, {id: string, label: string, actions: object[]}>} */
    const sections = new Map();
    let resolvedTarget = null;

    for (const entry of candidates) {
      // The context is built per interaction, and not just once, because each one
      // has its own distance, permission and policy. An action with
      // range 200 must not show up just because another one, with range 3000, fit.
      const built = await buildContext(actorId, entry, request.targetId, {}, { skipSchema: true });
      if (!built.ok) continue;

      resolvedTarget = built.ctx.target;
      const verdict = await runGuard(entry, built.ctx, 'canSee');
      if (!verdict.allowed) continue;

      if (!sections.has(entry.section)) {
        sections.set(entry.section, { id: entry.section, label: SECTION_LABELS[entry.section] || entry.section, actions: [] });
      }
      sections.get(entry.section).actions.push({
        action: entry.id,
        label: entry.label,
        fields: describeFields(entry.schema),
        // The client needs to know whether to generate a `requestId`; it does not need
        // to know the permission, the range or the audit class.
        requiresRequestId: entry.idempotent
      });
    }

    return {
      ok: true,
      stage: STAGES.DONE,
      targetType,
      target: resolvedTarget ? { type: resolvedTarget.type, id: resolvedTarget.id, label: resolvedTarget.label } : null,
      sections: Array.from(sections.values())
    };
  }

  /**
   * Executes an action picked in the menu, revalidating everything.
   *
   * @param {number} actorId
   * @param {{action?: unknown, targetType?: unknown, targetId?: unknown, requestId?: unknown, data?: unknown}} request
   */
  async function execute(actorId, request) {
    if (!request || typeof request !== 'object') {
      return fail(STAGES.ENVELOPE, 'Invalid request.');
    }
    if (!checkRate(actorId, 'execute')) {
      return fail(STAGES.RATE_LIMIT, 'Wait a moment before trying again.');
    }

    const actionId = typeof request.action === 'string' ? request.action : null;
    const entry = actionId ? registry.get(actionId) : undefined;
    if (!entry) {
      // Same message as an action that exists and is not available: saying
      // "this action does not exist" turns the menu into an enumeration oracle.
      logger.warn(`[interaction-service] unknown action from 0x${actorId.toString(16)}: ${String(actionId)}`);
      return fail(STAGES.UNKNOWN_ACTION, RECUSA_GENERICA);
    }

    // The target type comes from the descriptor, not from the request. Accepting the client's
    // `targetType` would allow calling a `player` action while declaring the target as a
    // `container` and landing in a resolver that does not make that action's refusals.
    const built = await buildContext(actorId, entry, request.targetId, request.data ?? request);
    if (!built.ok) return built;
    const ctx = built.ctx;

    const podeVer = await runGuard(entry, ctx, 'canSee');
    if (!podeVer.allowed) return fail(STAGES.CAN_SEE, podeVer.reason || RECUSA_GENERICA);

    const podeExecutar = await runGuard(entry, ctx, 'canExecute');
    if (!podeExecutar.allowed) return fail(STAGES.CAN_EXECUTE, podeExecutar.reason || RECUSA_GENERICA);

    // ── Deduplication ───────────────────────────────────────────────────────
    let dedupKey = null;
    if (entry.idempotent) {
      const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
      if (requestId.length < MIN_REQUEST_ID_LENGTH || requestId.length > MAX_REQUEST_ID_LENGTH) {
        return fail(STAGES.DUPLICATE, 'Invalid request.');
      }
      ctx.requestId = requestId;
      dedupKey = `${actorId}:${requestId}`;

      const timestamp = now();
      sweepDedup(timestamp);
      const previous = seen.get(dedupKey);
      if (previous) {
        // `running` is the real double click: the first one has not come back yet.
        // `done` is the retry after the response. Both return without executing.
        return previous.state === 'done' && previous.result
          ? { ...previous.result, duplicate: true }
          : fail(STAGES.DUPLICATE, 'This request is already being processed.');
      }
      seen.set(dedupKey, { state: 'running', at: timestamp });
    }

    // ── Execution ───────────────────────────────────────────────────────────
    try {
      const returned = await entry.execute(ctx);
      const result = {
        ok: true,
        stage: STAGES.DONE,
        interactionId: entry.id,
        message: returned && typeof returned === 'object' && typeof returned.message === 'string'
          ? returned.message
          : null,
        data: returned && typeof returned === 'object' && returned.data !== undefined ? returned.data : null
      };
      if (dedupKey) seen.set(dedupKey, { state: 'done', at: now(), result });
      await record(entry, ctx, 'ok', result.message);
      return result;
    } catch (err) {
      // The `requestId` is released on failure: the request did not happen, and the retry
      // with the same id is the correct client behavior.
      if (dedupKey) seen.delete(dedupKey);
      logger.error(`[interaction-service] '${entry.id}' failed:`, err.message);
      await record(entry, ctx, 'error', err.message);
      return fail(STAGES.EXECUTE, 'Could not complete the action.');
    }
  }

  /**
   * Bridge to `core/ui-event-router.js`.
   *
   * Two types, and only those. `interaction:query` answers through `browserModal`;
   * `interaction:execute` answers through a notification, because the result of an
   * action is a sentence, not a screen.
   *
   * @param {number} actorId
   * @param {{type?: string, data?: unknown}} uiEvent
   * @returns {Promise<boolean>} true if the event belonged to this module
   */
  async function handleUiEvent(actorId, uiEvent) {
    if (!uiEvent || typeof uiEvent !== 'object') return false;
    const type = uiEvent.type;
    if (type !== 'interaction:query' && type !== 'interaction:execute') return false;

    const data = uiEvent.data && typeof uiEvent.data === 'object' && !Array.isArray(uiEvent.data)
      ? /** @type {any} */ (uiEvent.data)
      : {};

    if (type === 'interaction:query') {
      const result = await query(actorId, data);
      if (!result.ok) {
        notify(actorId, /** @type {{reason: string}} */ (result).reason);
        return true;
      }
      // Only the list goes to the screen. The previous version of this feature also
      // dumped the actions' JSON into chat (`CORE_FRAMEWORK_AUDIT.md` §6.7b);
      // here there is a single channel.
      sendModal(actorId, 'interaction:actions', {
        target: result.target,
        targetType: result.targetType,
        sections: result.sections
      });
      return true;
    }

    const result = await execute(actorId, data);
    if (!result.ok) {
      notify(actorId, result.reason);
    } else if (result.message) {
      notify(actorId, result.message);
    }
    return true;
  }

  /** Diagnostics: how many requests are held in deduplication memory. */
  function snapshot() {
    return { pendingRequests: seen.size, dedupTtlMs };
  }

  return { query, peek, execute, handleUiEvent, snapshot, STAGES };
}

/**
 * Translates the server's `schema` into the form the CEF draws.
 *
 * It exists so the client **stops keeping its own field table**
 * (`ACTION_CONFIG` in `ui/index.html`). While both sides declare the
 * same fields, the day the server tightens a limit the UI keeps
 * offering the old one — and the player finds out by typing.
 *
 * @param {Record<string, any>|null} schema
 */
function describeFields(schema) {
  if (!schema) return [];
  return Object.entries(schema).map(([name, spec]) => ({
    name,
    type: spec.type,
    label: spec.label || name,
    required: Boolean(spec.required),
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.values ? { values: spec.values } : {}),
    ...(spec.placeholder ? { placeholder: spec.placeholder } : {})
  }));
}

module.exports = {
  createInteractionService,
  STAGES,
  DEFAULT_DEDUP_TTL_MS,
  normalizeVerdict,
  describeFields
};
