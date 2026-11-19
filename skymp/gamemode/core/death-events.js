/**
 * core/death-events.js
 *
 * Sole owner of `mp.onDeath`, with multiple named subscribers.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * Until 2026-08-08 `death-service.js` did `mp.onDeath = (actorId, killerId) =>
 * {...}` — direct assignment, and therefore **exclusive ownership**. A second module
 * that needed the same event would write over it, and the failure would be the worst
 * possible: player death detection through the primary path would simply
 * stop, with no error, no log and no crash. The 2 s polling that
 * `death-service` itself keeps as a safety net would hide the hole with two
 * seconds of delay, which is exactly a small enough interval for
 * nobody to suspect anything.
 *
 * `core/module-registry.js` had already written, on 2026-08-06, the exact condition
 * for reopening the topic of game-event distribution:
 *
 *   > "The trigger for reopening this (…): a second module that needs a
 *   > game event already captured by another one."
 *
 * `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.3 records that hostile mobs are the
 * first thing in this project to meet that trigger: when the
 * `hunting-service` exists, it will need `mp.onDeath` — the same hook —
 * for a **separate** pipeline (§11.4: a wolf has no `characterId`, cannot
 * be revived and cannot be retired).
 *
 * ─── Why a named bus, and not `descriptor.on` in the registry ───────────────
 *
 * §7.3 of that document suggests an optional `descriptor.on = { death: fn }` in
 * `register()`. This file diverges, on purpose, for two reasons:
 *
 *   1. **The registry does not know `mp`.** It is pure lifecycle
 *      (`initialize`/`shutdown`/`healthCheck`) and captures no events.
 *      To dispatch `onDeath` from there, `death-service` would have to call
 *      back into the registry, which would then call the other modules —
 *      a dependency inversion there is no need for today.
 *   2. **It is the house's own precedent.** When a second consumer really
 *      showed up — governance needing to notify the panel —, the answer was
 *      `core/panel-refresh-bus.js`: a small, named bus, not a generic
 *      channel. The registry's comment calls that the "model if a third
 *      case shows up", and this is the third case.
 *
 * The generic channel still does not exist, and still should not exist until
 * `onCellChange` (which has no consumer today) gets one.
 *
 * ─── What this file does NOT do ──────────────────────────────────────────────
 *
 * It does not filter, does not decide whether the dead one is a player or a creature, and does not know what a
 * mob is. It hands the raw `(actorId, killerId)` to whoever subscribed; each subscriber
 * decides in O(1) whether it is their business. That requirement comes from §7.2 of the
 * mobs document: with active fauna this hook starts firing constantly, and **the death
 * path must not touch the DB before deciding it cares**.
 *
 * ─── The return value blocks the native respawn, which is why it is aggregated ─
 *
 * **`[DOC]`** `gamemode_events/DeathEvent.cpp`: `OnFireSuccess` calls
 * `actor->RespawnWithDelay()`. **`[DOC]`** `GameModeEvent::Fire` only calls
 * `OnFireSuccess` if **no** listener returned `false`. **`[DOC]`**
 * `ScampServerListener.cpp:41-129` fixes the JS handler contract:
 *
 *   | returns      | effect                                         |
 *   |--------------|------------------------------------------------|
 *   | `undefined`  | does not block → **automatic respawn in 25 s** |
 *   | `false`      | blocks → the server does not respawn           |
 *   | throws       | error logged, **does not block**               |
 *
 * Until 2026-08-09 `_dispatch` was a `for` loop without `return` — it returned
 * `undefined`, and therefore **the server resurrected the player after 25 seconds**
 * while `death-service` still considered them `DOWNED`, waiting out the 4 minutes
 * of bleed-out. Two authorities over the same state, which is the defect that
 * `REVISAO_REALIDADE_COMPARTILHADA.md` §6.2 recorded as a Phase 0 blocker.
 *
 * **The policy is "block if any subscriber asks", and it is deliberate.**
 * §6.2 of that document points out the risk of a global `return false`: the
 * `hunting-service` will subscribe to this same hook, and `RespawnWithDelay` is how the
 * server returns **any** dead actor to the world — blocking everything would kill
 * mob respawn as well. With aggregation, each subscriber answers only for what is
 * theirs: whoever does not recognize the actor returns `undefined` and does not interfere; whoever
 * takes over the lifecycle of that death returns `false`. A subscriber that **throws**
 * does not block — same rule as upstream, and for the same reason: one
 * consumer's failure must not become a world decision.
 *
 * **What this does not reach.** **`[DEEPWIKI]`** (reference §9.2,
 * `PartOne.cpp:175-221`) `PartOne::SetUserActor` calls `RespawnWithDelay()` if the
 * actor is dead at handshake. A player who goes down and **reconnects** is
 * respawned through that path, which does not go through here. Blocking the event
 * solves the main path, not all of them — and that is a Phase 0 observation, not
 * a fix for this round.
 *
 * ─── Provenance ──────────────────────────────────────────────────────────────
 *
 * `mp.onDeath(actorId, killerId)` is **[OFFICIAL TEST]** — upstream `misc/tests/test_isdead.js`,
 * typed in `types/mp.d.ts`. **It has never fired in a real session of this
 * server** (Step 9 of `FASE_0_ROTEIRO.md`). This bus does not change that:
 * it guarantees that, when it fires, it reaches everyone who asked.
 */

// nome do assinante → handler
const _subscribers = new Map();

let _hookInstalled = false;

/**
 * Hands the event to each subscriber, isolating failures, and aggregates the return value.
 *
 * A subscriber that throws **must not** stop the others from running: if
 * `hunting-service` breaks while granting loot, the player's fall still needs to
 * become DOWNED. It is the same reason `_dispatch` does not use `for...of` with
 * `await` — there is nothing asynchronous here on purpose; whoever needs the DB
 * fires their own promise and handles their own error.
 *
 * The loop does **not** exit early when someone returns `false`: every subscriber
 * must see every death. Blocking is the aggregated decision at the end, not a shortcut
 * that silences whoever comes later in subscription order.
 *
 * @returns {false|undefined} `false` if any subscriber asked to block the
 *   native respawn; `undefined` otherwise (which is what does not block).
 */
function _dispatch(actorId, killerId) {
  let bloquearRespawn = false;

  for (const [name, handler] of _subscribers) {
    try {
      // `=== false` on purpose: only the exact boolean asks for a block. A
      // subscriber that carelessly returns `0`, `''` or `null` must not
      // turn off the server's respawn without having asked to.
      if (handler(actorId, killerId) === false) bloquearRespawn = true;
    } catch (err) {
      console.error(
        `[death-events] Subscriber '${name}' threw in onDeath: ${err.message}. ` +
        `The other subscribers keep running, and the exception does NOT block the native respawn.`
      );
    }
  }

  // Explicit `undefined`, not `false`: returning `false` by default would block the
  // respawn of every dead actor in the world, mobs included.
  return bloquearRespawn ? false : undefined;
}

/**
 * Installs the hook exactly once. Idempotent.
 *
 * Called by `subscribe()`, not by boot: with no subscriber there is no reason to
 * occupy `mp.onDeath`, and the failure mode points to the inert side.
 */
function _installHook() {
  if (_hookInstalled) return;
  if (typeof mp === 'undefined') return;

  // If someone already assigned directly, the bus is about to do to the other one
  // exactly what it exists to prevent. The previous handler cannot be recovered
  // safely (we know neither its name nor its order), so we scream.
  if (typeof mp.onDeath === 'function') {
    console.error(
      '[death-events] mp.onDeath ALREADY had a function assigned before this bus. ' +
      'Someone is using `mp.onDeath = ...` directly — the previous handler will be lost. ' +
      'Replace that assignment with deathEvents.subscribe(<name>, fn).'
    );
  }

  mp.onDeath = (actorId, killerId) => _dispatch(actorId, killerId);
  _hookInstalled = true;
}

/**
 * Registers a death consumer.
 *
 * @param {string} name    Module name, so the error log says who broke
 * @param {(actorId: number, killerId: number) => void} handler
 *
 * Throws on a duplicate name on purpose. Registering twice is a programming
 * error (an `initialize` called twice, or two modules with the same
 * name), and silencing it reintroduces the defect this file removes: a
 * lost handler without anyone knowing. `module-registry` catches the exception,
 * marks the module as `FAILED to initialize` and continues booting — loud and
 * contained, which is the desired behavior.
 */
function subscribe(name, handler) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('[death-events] subscribe requires a non-empty name');
  }
  if (typeof handler !== 'function') {
    throw new Error(`[death-events] subscribe('${name}') requires a function`);
  }
  if (_subscribers.has(name)) {
    throw new Error(
      `[death-events] '${name}' is already subscribed to onDeath. ` +
      `A duplicate subscription hides a lost handler — that is why this bus exists.`
    );
  }

  _subscribers.set(name, handler);
  _installHook();
}

/**
 * Removes a subscriber. Used in modules' `shutdown()`.
 * @param {string} name
 * @returns {boolean} whether there was anything to remove
 */
function unsubscribe(name) {
  return _subscribers.delete(name);
}

/** Who is listening right now. For diagnostics and tests. */
function subscriberNames() {
  return [..._subscribers.keys()];
}

/**
 * Returns the bus to its boot state: no subscribers and no hook installed.
 *
 * It exists only for tests, and for a specific reason: since this module is a
 * singleton, a test that runs after another inherits `_hookInstalled = true` and
 * never exercises installing the hook. Installation is exactly where the
 * protection against a direct `mp.onDeath = ...` lives, so without this the most
 * dangerous regression — the second module wiping out `death-service` — cannot be reproduced.
 */
function _resetForTest() {
  _subscribers.clear();
  _hookInstalled = false;
  if (typeof mp !== 'undefined') delete mp.onDeath;
}

module.exports = {
  subscribe,
  unsubscribe,
  subscriberNames,
  // Exposed only for tests: allows exercising dispatch without depending on the
  // `mp` mock having been installed before the require.
  _dispatch,
  _resetForTest
};
