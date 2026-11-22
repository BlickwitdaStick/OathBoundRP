/**
 * Testable bridge between the CEF (the browser embedded in the client) and the gamemode.
 *
 * ─── `mp.onUiEvent` never existed — BOUND-004 ───────────────────────────────
 *
 * Until 2026-08-20 this file did `mpApi.onUiEvent = gateway`. SkyMP
 * **never calls that property** — searching `skymp5-client/src`,
 * `skymp5-server/cpp`, `skymp5-front/src` and `skymp5-functions-lib/src` for
 * `onUiEvent`: zero occurrences, confirmed twice (2026-08-14 and 2026-08-20,
 * the second directly against upstream `main` via `gh api`). See
 * `docs/research/SKYMP_INTEGRATION_AUDIT.md` §5 (`BOUND-004`) for the
 * full investigation. Until then, `ui-event-router`, `ui-event-rate-limiter`,
 * the `governance`/`player-panel` schemas and the whole interaction menu
 * were wired to a dead callback — no CEF event ever reached
 * the server through the normal path.
 *
 * The real path, officially documented
 * (upstream `docs/skyrim_platform/browser.md`), is three hops:
 *
 *   1. **CEF -> client.** The page calls `window.skyrimPlatform.sendMessage(...)`.
 *      Skyrim Platform emits the `browserMessage` event, with the arguments
 *      in `e.arguments`.
 *   2. **Client -> server.** `mp.makeEventSource('_onUiEvent', <snippet>)`
 *      injects a snippet that runs on the client, subscribes to `ctx.sp.on('browserMessage', ...)`
 *      and forwards via `ctx.sendEvent(...)`.
 *   3. **Server -> gamemode.** SkyMP fires `mp._onUiEvent(pcFormId, ...args)`
 *      — a custom event name MUST start with `_`.
 *
 * Same technique already used in `core/hit-events.js` for `_onHitReported` —
 * `mp.makeEventSource` has been confirmed on a real server since 2026-08-06
 * (see that file's header). The client snippet here, like the one there,
 * **was not exercised against a real CEF** in this fix — only the
 * server-side part (event source registration + dispatch) has automated tests.
 *
 * `ui/index.html` was fixed alongside: `sendUiEvent` sent
 * `window.mp.trigger(...)`/`window.mp.send(...)` — `window.mp` is not injected
 * into SkyMP's CEF (searching upstream for `window.mp` only shows up in
 * `skymp5-front`, the separate admin panel, not in the game client).
 * It now uses `window.skyrimPlatform.sendMessage({ type, data })` — a
 * single argument, so that `ctx.sendEvent(...e.arguments)` forwards the
 * whole envelope as `args[0]` on the server side.
 *
 * This module still knows nothing about `mp`, the DB or gameplay: it receives its
 * dependencies and returns the callback — the only difference is where it is hung.
 */

/**
 * @param {{
 *   uiEventRouter: {isValidEventEnvelope: Function, dispatch: Function},
 *   handleChatInput: Function,
 *   rateLimiter?: {observe: Function},
 *   logger?: Pick<Console, 'log'|'warn'|'error'>
 * }} dependencies
 * @returns {(actorId: number, uiEvent: unknown) => boolean}
 */
function createUiEventGateway({ uiEventRouter, handleChatInput, rateLimiter, logger = console }) {
  if (!uiEventRouter || typeof uiEventRouter.isValidEventEnvelope !== 'function' || typeof uiEventRouter.dispatch !== 'function') {
    throw new Error('[ui-event-gateway] invalid uiEventRouter');
  }
  if (typeof handleChatInput !== 'function') {
    throw new Error('[ui-event-gateway] invalid handleChatInput');
  }
  if (rateLimiter && typeof rateLimiter.observe !== 'function') {
    throw new Error('[ui-event-gateway] invalid rateLimiter');
  }

  return (actorId, uiEvent) => {
    try {
      if (!uiEventRouter.isValidEventEnvelope(uiEvent)) {
        logger.warn(`[phase0] Ignoring malformed UI event from ${actorId.toString(16)}`);
        return false;
      }

      /** @type {{type: string, data?: unknown}} */
      const event = /** @type {any} */ (uiEvent);

      if (rateLimiter) {
        const result = rateLimiter.observe(actorId, event.type);
        if (!result || result.allowed !== true) {
          logger.warn(`[phase0] UI event rate limited from ${actorId.toString(16)}: type=${event.type}`);
          return false;
        }
      }

      // Never log the raw payload: it is controlled by the client and may
      // contain private text or data that is not needed for diagnostics.
      logger.log(
        `[phase0] onUiEvent callback from ${actorId.toString(16)}: ` +
        `type=${event.type} data=${describeEventData(event.data)}`
      );
      Promise.resolve(uiEventRouter.dispatch(actorId, event)).catch(err =>
        logger.error('[phase0] ui-event-router dispatch failed:', err.message)
      );

      if (event.type === 'cef::chat:send') {
        handleChatInput(actorId, event.data);
      }
      return true;
    } catch (err) {
      logger.error('[phase0] Error in onUiEvent:', err.message);
      return false;
    }
  };
}

/** Event source name — MUST start with `_` (ActionListener::OnCustomEvent). */
const NOME_DO_EVENTO = '_onUiEvent';

/**
 * The snippet that runs ON THE CLIENT, inside Skyrim Platform. Written as a
 * string because that is what `makeEventSource` takes — nothing here has access to
 * this file's scope, only to the `ctx` that SkyMP provides.
 *
 * `e.arguments` is the array `window.skyrimPlatform.sendMessage(...)` sent
 * from the CEF side. `ui/index.html` always sends ONE argument (the
 * `{type, data}` envelope), so `...e.arguments` here always becomes a
 * single-argument call — and on the server side `args[0]` is that envelope.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.sp.on('browserMessage', (e) => {
    try {
      ctx.sendEvent(...e.arguments);
    } catch (err) {
      // An error here runs on the client and has nowhere to go — swallowing it is the same
      // criterion as core/hit-events.js: crashing the snippet would kill every
      // following UI event from that player, not just this one.
    }
  });
`;

/**
 * Registers the `_onUiEvent` event source and wires dispatch to it. Kept
 * testable without loading the whole bootstrap — it receives `mpApi` instead
 * of importing the global `mp`.
 *
 * @param {{makeEventSource?: Function, [key: string]: any}} mpApi
 * @param {Parameters<typeof createUiEventGateway>[0]} dependencies
 * @returns {(actorId: number, uiEvent: unknown) => boolean} the pure gateway, for direct testing
 */
function installUiEventGateway(mpApi, dependencies) {
  if (!mpApi || typeof mpApi !== 'object') throw new Error('[ui-event-gateway] invalid mp');
  const gateway = createUiEventGateway(dependencies);
  const logger = (dependencies && dependencies.logger) || console;

  if (typeof mpApi.makeEventSource !== 'function') {
    logger.warn('[ui-event-gateway] mp.makeEventSource unavailable — no UI events will be received.');
    return gateway;
  }

  mpApi.makeEventSource(NOME_DO_EVENTO, SNIPPET_DO_CLIENTE);
  mpApi[NOME_DO_EVENTO] = (pcFormId, ...args) => gateway(pcFormId, args[0]);
  return gateway;
}

/**
 * Returns only the category of a payload received from the UI, without leaking its
 * contents into the server logs.
 * @param {unknown} data
 * @returns {string}
 */
function describeEventData(data) {
  if (data === undefined) return 'absent';
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  return typeof data;
}

module.exports = { createUiEventGateway, installUiEventGateway, NOME_DO_EVENTO, SNIPPET_DO_CLIENTE };
