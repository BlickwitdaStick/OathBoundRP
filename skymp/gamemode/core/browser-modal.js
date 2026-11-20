/**
 * core/browser-modal.js
 *
 * The single server → CEF channel for chat lines, toasts, choice prompts and
 * module screens: the `browserModal` property, handled in the page by
 * `window.handleServerModal` (skymp/ui/index.html).
 *
 * Why a queue (19/11/2026):
 *   - A SkyMP property only replicates its LATEST value. Two messages in the
 *     same tick (a chat line and a reply, a broadcast reaching you twice) used
 *     to lose all but the last.
 *   - The client re-runs updateOwner every frame, so a plain `{type, data}`
 *     value was re-delivered — and re-added to the chat log — every frame.
 *
 * So each player's value carries their last MAX_QUEUE messages, each with a
 * process-wide increasing `id`; the page handles only ids it has not seen.
 * The top-level `type`/`data` still mirror the newest message for callers and
 * tests that read them directly.
 */

'use strict';

const MAX_QUEUE = 30;

/** actorId -> [{ id, type, data }] (newest last) */
const _queues = new Map();

// Starts from the clock so ids keep increasing across server restarts: the
// in-game page (and its "last seen id") can outlive a server restart.
let _nextId = Date.now() * 1000;

function nextId() {
  _nextId += 1;
  return _nextId;
}

/**
 * Queues a message for one player and publishes the queue.
 * @param {number} actorId
 * @param {string} type  e.g. 'toast', 'choice', 'interaction:open', 'depot:open'
 * @param {unknown} data
 * @returns {boolean} false when it could not be sent
 */
function pushModal(actorId, type, data) {
  if (typeof mp === 'undefined') return false;
  const queue = _queues.get(actorId) || [];
  const message = { id: nextId(), type, data };
  queue.push(message);
  while (queue.length > MAX_QUEUE) queue.shift();
  _queues.set(actorId, queue);
  try {
    mp.set(actorId, 'browserModal', { type, data, id: message.id, sentAt: Date.now(), messages: queue.slice() });
    return true;
  } catch (err) {
    console.error(`[browser-modal] Failed to send '${type}' to 0x${actorId.toString(16)}:`, err.message);
    return false;
  }
}

/** Drop a player's queue (disconnect); actorIds are reused by SkyMP. */
function forgetActor(actorId) {
  _queues.delete(actorId);
}

/**
 * Client snippet for the property: forward each NEW value once (dedupe on
 * sentAt — the client runs this every frame).
 */
const UPDATE_OWNER_SNIPPET = `
  if (ctx.value && ctx.value.sentAt !== ctx.state.browserModalSentAt && ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
    ctx.state.browserModalSentAt = ctx.value.sentAt;
    ctx.sp.browser.executeJavaScript('window.handleServerModal && window.handleServerModal(' + JSON.stringify(ctx.value) + ')');
  }
`;

module.exports = { MAX_QUEUE, pushModal, forgetActor, UPDATE_OWNER_SNIPPET, _queues };
