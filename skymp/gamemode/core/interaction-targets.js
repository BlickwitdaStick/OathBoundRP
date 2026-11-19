/**
 * core/interaction-targets.js
 *
 * Translates what the client **says** the target is into what the server **knows**
 * about it.
 *
 * ─── The only rule in this file ─────────────────────────────────────────────
 *
 * The client suggests; the server confirms. An interaction request arrives with
 * `{targetType, targetId}` — two fields the player's machine picked. The
 * resolver takes those two fields and returns **the object the server already
 * had**: the loaded character, the stall from the DB, the cell's door. If it
 * does not find one, the request dies here.
 *
 * What never goes into a resolved target: distance, owner, balance, state, price
 * or permission coming from the payload. Those the server computes or reads from the DB —
 * §7 of the request, and `CONTRIBUTING.md` §3.6 ("a client event is a hint, not
 * proof").
 *
 * ─── Why only `player` and `object` have resolvers ──────────────────────────
 *
 * Because they are the only ones with a consumer. `container`, `door`, `npc`, `property`
 * and `world_point` remain reserved vocabulary in `interaction-registry`;
 * the day a module needs one of them, it calls
 * `registerResolver('container', fn)` in `initialize()` and nothing here changes.
 *
 * `object` (since the Miner MVP, see `docs/gameplay/MINING.md` §1) is the
 * first target that is not an actor: any `MpObjectReference` in the world,
 * identified by the FormId the client itself reports when interacting — never
 * a hand-typed FormDesc. `mp.get(formId, 'locationalData')` is **[DOC]**
 * in `types/mp.d.ts` (the `LocationalData` interface describes the position "of an
 * object", not "of an actor", and the `get()` signature is generic over
 * `FormId`) — but it was never exercised by this project against a reference
 * that was not an actor. Decision made with the user: trust the official
 * documentation and implement, marking this as **assumed, not tested in
 * game**, until the first manual validation on a real server.
 *
 * Writing the remaining four now would mean writing functions with no caller,
 * against SkyMP APIs this project never exercised (`mp.get(id,'inventory')`
 * is still marked **[DOC]** and untested — see `ARCHITECTURE.md` §1.4.9). It is the
 * same criterion recorded in the `module-registry` header on 2026-08-06, and
 * the alternative — guessed resolvers — is worse than absence, because it
 * looks finished.
 *
 * A type with no resolver fails **closed and by name**: "unsupported target
 * type", with a log. Never `undefined` flowing down the pipeline.
 */

const rangeUtils = require('./range-utils');
const { TARGET_TYPES } = require('./interaction-registry');

/**
 * Accepts `123`, `"123"`, `"0x7b"` and `"7B"`.
 *
 * All four really arrive: the interaction menu formats actorId as
 * `0x...` (`ui/index.html`, `formatActorId`), chat sends decimal, and
 * `browserModal` round-trips through JSON. Rejecting one of the formats would break a
 * path that works today.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseActorId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
  const parsed = Number.parseInt(clean, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Same shape as `parseActorId` — accepts `123`, `"123"`, `"0x7b"`, `"7B"` —
 * with its own name because here the number is not an actor, it is the FormId of some
 * `MpObjectReference` the client reported when interacting.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseFormId(raw) {
  return parseActorId(raw);
}

/**
 * @typedef {object} AlvoResolvido
 * @property {string} type           the declared type (already validated)
 * @property {string} id             stable identifier, for logging and dedupe
 * @property {string} label          short name for the UI and the audit
 * @property {number} [actorId]      when the target is an actor in the world
 * @property {number} [formId]       when the target is any MpObjectReference
 * @property {number} [characterId]  when the target is a persisted character
 * @property {number|null} [accountId]
 * @property {object} [character]    the record the server already had at hand
 * @property {(actorId: number, maxRange: number) => {ok: boolean, reason?: string, unverified?: boolean}} [assertRange]
 */

/**
 * Creates the set of resolvers.
 *
 * Receives `getCharacter` by injection instead of importing `commands.js`: whoever knows
 * who is logged in is `commands.js`, which imports half the gamemode. A
 * dependency like that here would make this file — which must be testable without a
 * server — impossible to load in a test.
 *
 * @param {{getCharacter: (actorId: number) => object|null|undefined, logger?: Pick<Console,'warn'|'error'>}} deps
 */
function createTargetResolvers({ getCharacter, logger = console }) {
  if (typeof getCharacter !== 'function') {
    throw new Error('[interaction-targets] invalid getCharacter');
  }

  /** @type {Map<string, (rawTargetId: unknown, actorId: number) => AlvoResolvido|null>} */
  const resolvers = new Map();

  /**
   * The target is someone else in the world.
   *
   * Two refusals, and both matter:
   *
   *   1. **No loaded character, no target.** A raw actorId can be a
   *      vanilla NPC, another player's actor still choosing a character, or
   *      a made-up number. `getCharacter` only answers for whoever went through the
   *      whitelist and picked a character.
   *   2. **Nobody is their own target through this path.** Interacting with yourself is the
   *      panel (`/panel`), not a context menu. Governance already made that
   *      refusal (`actorId === targetActorId`) — and it is why the
   *      `isSelf` branch of `market-stalls` was never reachable
   *      (`CORE_FRAMEWORK_AUDIT.md` §6.7a). Keeping the rule here, in a single place,
   *      is what allows fixing that without duplicating the decision.
   */
  resolvers.set(TARGET_TYPES.PLAYER, (rawTargetId, actorId) => {
    const targetActorId = parseActorId(rawTargetId);
    if (targetActorId === null) return null;
    if (targetActorId === actorId) return null;

    const character = getCharacter(targetActorId);
    if (!character) return null;

    return {
      type: TARGET_TYPES.PLAYER,
      id: `player:${targetActorId}`,
      label: `0x${targetActorId.toString(16)}`,
      actorId: targetActorId,
      characterId: character.characterId,
      accountId: character.accountId || null,
      character,
      assertRange: (fromActorId, maxRange) => rangeUtils.assertRange(fromActorId, targetActorId, maxRange)
    };
  });

  /**
   * The target is any `MpObjectReference` in the world — a mining vein
   * today, potentially any interactive object tomorrow.
   *
   * Unlike `player`, the client here reports the **FormId** of what it is
   * aiming at, not a typed FormDesc. It is the same trust pattern that
   * `player` already uses (the client points at the target, the server measures distance and
   * decides the rest) — the only difference is the kind of object on the other side.
   *
   * `assertRange` reuses `rangeUtils.assertRange` unchanged: the
   * implementation was already generic over `mp.get(id, 'locationalData')`, it never
   * required the second id to be an actor. See the provenance warning in the
   * header of this file — `locationalData` against an ordinary object is
   * **assumed from the official docs, not validated in game**.
   */
  resolvers.set(TARGET_TYPES.OBJECT, (rawTargetId) => {
    const formId = parseFormId(rawTargetId);
    if (formId === null) return null;

    return {
      type: TARGET_TYPES.OBJECT,
      id: `object:${formId}`,
      label: `0x${formId.toString(16)}`,
      formId,
      assertRange: (fromActorId, maxRange) => rangeUtils.assertRange(fromActorId, formId, maxRange)
    };
  });

  /**
   * Registers a resolver for a target type that does not have one yet.
   *
   * Called in the `initialize()` of whoever owns that type — `properties`
   * for `property`, `crafting` for `object`, and so on. The core does not
   * need to know they exist.
   *
   * @param {string} targetType
   * @param {(rawTargetId: unknown, actorId: number) => AlvoResolvido|null} resolver
   */
  function registerResolver(targetType, resolver) {
    if (typeof resolver !== 'function') {
      throw new Error(`[interaction-targets] resolver for '${targetType}' is invalid`);
    }
    if (resolvers.has(targetType)) {
      throw new Error(`[interaction-targets] '${targetType}' already has a resolver`);
    }
    resolvers.set(targetType, resolver);
  }

  /**
   * @param {string} targetType
   * @param {unknown} rawTargetId
   * @param {number} actorId  who is interacting
   * @returns {{ok: true, target: AlvoResolvido}|{ok: false, reason: string}}
   */
  function resolve(targetType, rawTargetId, actorId) {
    const resolver = resolvers.get(targetType);
    if (!resolver) {
      // Not a player error: either the type is valid and has no owner yet, or the
      // client sent a type that does not exist. The message is the same for
      // both — describing the difference would teach people to probe the server.
      logger.warn(`[interaction-targets] no resolver for type '${targetType}'`);
      return { ok: false, reason: 'Unsupported target type.' };
    }

    let target;
    try {
      target = resolver(rawTargetId, actorId);
    } catch (err) {
      logger.error(`[interaction-targets] resolver for '${targetType}' failed:`, err.message);
      return { ok: false, reason: 'Invalid target.' };
    }

    if (!target) return { ok: false, reason: 'Invalid target.' };
    return { ok: true, target };
  }

  function supportedTypes() {
    return Array.from(resolvers.keys());
  }

  return { resolve, registerResolver, supportedTypes };
}

module.exports = { createTargetResolvers, parseActorId, parseFormId };
