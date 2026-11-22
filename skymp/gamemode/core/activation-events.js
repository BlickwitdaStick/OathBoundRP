/**
 * Sole owner of `mp.onActivate`, with multiple named subscribers.
 *
 * The SkyMP hook is synchronous: only the exact boolean `false` blocks
 * vanilla processing. Subscribers that need the DB must decide in
 * O(1) whether they recognize the FormID, start the async work on their own
 * and return `false` immediately when they consume the activation.
 */
'use strict';

const _subscribers = new Map();
let _hookInstalled = false;

function _dispatch(targetId, casterId) {
  let consumed = false;
  for (const [name, handler] of _subscribers) {
    try {
      if (handler(targetId, casterId) === false) consumed = true;
    } catch (err) {
      console.error(
        `[activation-events] Subscriber '${name}' threw in onActivate: ${err.message}. ` +
        'The other subscribers keep running and the exception does NOT block the vanilla activation.'
      );
    }
  }
  return consumed ? false : undefined;
}

function _installHook() {
  if (_hookInstalled || typeof mp === 'undefined') return;
  if (typeof mp.onActivate === 'function') {
    throw new Error(
      '[activation-events] mp.onActivate already has a direct handler. ' +
      'Migrate the consumer to activationEvents.subscribe(<name>, fn).'
    );
  }
  mp.onActivate = (targetId, casterId) => _dispatch(targetId, casterId);
  _hookInstalled = true;
}

function subscribe(name, handler) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('[activation-events] subscribe requires a non-empty name');
  }
  if (typeof handler !== 'function') {
    throw new Error(`[activation-events] subscribe('${name}') requires a function`);
  }
  if (_subscribers.has(name)) {
    throw new Error(`[activation-events] '${name}' is already subscribed to onActivate`);
  }
  _subscribers.set(name, handler);
  _installHook();
}

function unsubscribe(name) { return _subscribers.delete(name); }
function subscriberNames() { return [..._subscribers.keys()]; }

function _resetForTest() {
  _subscribers.clear();
  _hookInstalled = false;
  if (typeof mp !== 'undefined') delete mp.onActivate;
}

module.exports = { subscribe, unsubscribe, subscriberNames, _dispatch, _resetForTest };

