/**
 * core/papyrus.js
 *
 * Helpers for crossing the Papyrus bridge.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * The `self` parameter of `mp.callPapyrusFunction('method', ...)` — and any
 * argument that is an object reference — must be an **object**
 * `{ type, desc }`, never the numeric FormID:
 *
 *     mp.callPapyrusFunction('method', 'Actor', 'IsDead', actorRef(id), []);
 *
 * This is not a style preference. SkyMP's nine official tests
 * (`misc/tests/` in the upstream repository) use **only** that shape,
 * including for arguments:
 *
 *     mp.callPapyrusFunction("method", "ObjectReference", "RemoveAllItems",
 *         { type: "form", desc: mp.getDescFromId(actorId1) },
 *         [{ type: "form", desc: mp.getDescFromId(actorId2) }, false, false]);
 *
 * Until 2026-08-05 this gamemode mixed both shapes: 2 files used
 * the object and 22 call sites passed the raw FormID. Since nothing was ever tested in
 * game and the official documentation says nothing about it, it went unnoticed
 * for ages — and the test suite passed, because the mocked `mp` accepts
 * anything.
 *
 * The concrete risk was `core/transaction-service.js`: if the raw shape does not
 * work, the DB recorded the transaction and the item never reached the
 * player's inventory.
 *
 * ─── `form` vs `espm` ────────────────────────────────────────────────────────
 *
 * `type: 'form'`  → a reference that exists in the world (an actor, a placed object)
 * `type: 'espm'`  → a base record coming from a plugin (the "template" of an item)
 *
 * The distinction shows up in the official tests: the actor is `form`, the Gold001 that is
 * added to their inventory is `espm`.
 */

/**
 * A reference to something that exists in the world — an actor or a placed object.
 * It is what goes in the `self` of every `'method'` call.
 *
 * @param {number} formId
 * @returns {{type: 'form', desc: string}}
 */
function actorRef(formId) {
  return { type: 'form', desc: mp.getDescFromId(formId) };
}

/**
 * A reference to a plugin base record (item baseId, NPC, etc).
 * Used as an *argument*, not as `self`.
 *
 * @param {number} baseId
 * @returns {{type: 'espm', desc: string}}
 */
function baseRef(baseId) {
  return { type: 'espm', desc: mp.getDescFromId(baseId) };
}

module.exports = { actorRef, baseRef };
