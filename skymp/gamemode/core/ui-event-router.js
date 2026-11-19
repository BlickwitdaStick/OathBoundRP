/**
 * core/ui-event-router.js
 *
 * Central routing of events coming from the UI (CEF) to the modules.
 * Replaces the hardcoded single handler that called one module at a time. The
 * event arrives here via `core/ui-event-gateway.js`, which receives it from the CEF
 * through `mp.makeEventSource('_onUiEvent', ...)` — not through `mp.onUiEvent`
 * (a property SkyMP never called; see BOUND-004 in that file's header
 * and `docs/research/SKYMP_INTEGRATION_AUDIT.md` §5).
 *
 * Each module registers a prefix (the part of uiEvent.type before the first ':'),
 * e.g. 'governance:interaction:actions' → prefix 'governance'.
 *
 * Usage:
 *   uiEventRouter.register('governance', governance.handleUiEvent);
 *   uiEventRouter.register('panel', playerPanel.handleUiEvent);
 *   ...
 *   uiEventRouter.dispatch(actorId, uiEvent); // dispatches to the handler for its prefix
 *
 * A handler returns true if it handled the event.
 *
 * ─── Dispatching to every handler was removed (2026-08-13) ──────────────────
 *
 * Until then, `dispatch` called the prefix handler and **then all the
 * others**, unconditionally. The original comment called that
 * compatibility with `governance:interaction:*` events handled by handlers
 * that did not follow their own prefix.
 *
 * That case no longer exists: the two handlers registered today
 * (`governance-service` and `player-panel-service`) only act on their own
 * prefix, and both reject the rest with `return false` — the protection was each
 * handler's good manners, not the router. The cost was real: **every module with
 * UI saw the payload of every UI event from every player**, and the price of each
 * event grew with the number of modules, not with the number of events.
 *
 * That is what the audit classified as REFACTOR
 * (`docs/research/CORE_FRAMEWORK_AUDIT.md` §3): it was not a security flaw —
 * no handler acted on someone else's event —, it was the surface where the next one
 * would be born, and the coupling the Interaction Framework exists to remove.
 *
 * An event with no owner is now logged once per type, not on every
 * occurrence: the `type` is chosen by the client, and one log per event would be a
 * way to fill the server's disk from the outside.
 */

// Map of prefix → handler(actorId, uiEvent) => boolean | Promise<boolean>
const _handlers = new Map();
const MAX_EVENT_TYPE_LENGTH = 128;

// Types already reported as ownerless. Bounded so a hostile client cannot
// turn the diagnostic into a memory leak.
const _semDono = new Set();
const MAX_TIPOS_SEM_DONO_REPORTADOS = 64;

/**
 * Validates the minimal envelope that crosses the CEF -> gamemode boundary.
 *
 * This does not validate `data`: each module owns the schema of its command.
 * The goal here is to stop a malformed payload from reaching handlers that
 * assume `uiEvent.type` is a string.
 *
 * @param {unknown} uiEvent
 * @returns {boolean}
 */
function isValidEventEnvelope(uiEvent) {
  /** @type {{ type?: unknown } | null} */
  const event = uiEvent && typeof uiEvent === 'object' && !Array.isArray(uiEvent)
    ? uiEvent
    : null;

  return Boolean(
    event &&
    typeof event.type === 'string' &&
    event.type.length > 0 &&
    event.type.length <= MAX_EVENT_TYPE_LENGTH
  );
}

/**
 * Registers a handler for an event prefix.
 * @param {string} prefix - uiEvent.type prefix (e.g. 'governance', 'panel')
 * @param {Function} handler - async (actorId, uiEvent) => boolean
 */
function register(prefix, handler) {
  if (!prefix) throw new Error('[ui-event-router] Handler has no prefix');
  if (typeof handler !== 'function') throw new Error(`[ui-event-router] Handler '${prefix}' is invalid`);
  _handlers.set(prefix, handler);
}

/**
 * Removes a registered handler.
 * @param {string} prefix
 */
function unregister(prefix) {
  _handlers.delete(prefix);
}

/**
 * Dispatches a uiEvent to the handler whose prefix matches uiEvent.type.
 *
 * Only to that one. An event with no handler registered for its prefix is not
 * offered to anyone else — see the note at the top of this file.
 *
 * @param {number} actorId
 * @param {object} uiEvent - { type: string, data?: object }
 * @returns {Promise<boolean>} true if the handler handled the event
 */
async function dispatch(actorId, uiEvent) {
  if (!isValidEventEnvelope(uiEvent)) return false;

  const prefix = uiEvent.type.split(':')[0];
  const handler = _handlers.get(prefix);

  if (!handler) {
    if (!_semDono.has(prefix) && _semDono.size < MAX_TIPOS_SEM_DONO_REPORTADOS) {
      _semDono.add(prefix);
      console.warn(`[ui-event-router] No handler registered for prefix '${prefix}' (first occurrence).`);
    }
    return false;
  }

  try {
    // A handler's exception does not bubble up to the gateway: up there it would become a
    // generic `return false` and the name of the guilty module would be lost.
    return Boolean(await handler(actorId, uiEvent));
  } catch (err) {
    console.error(`[ui-event-router] Error in handler '${prefix}':`, err.message);
    return false;
  }
}

function list() {
  return Array.from(_handlers.keys());
}

module.exports = { register, unregister, dispatch, list, isValidEventEnvelope };
