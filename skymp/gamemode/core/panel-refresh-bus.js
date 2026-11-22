/**
 * core/panel-refresh-bus.js
 *
 * Decoupled event bus for "something changed, the Player Panel
 * of this actor should refresh". It exists to avoid a circular dependency
 * between player-panel-service.js (which already depends on governance-service.js and
 * market-stalls-service.js to build snapshots) and those same services
 * (which now need to signal when one of their actions affects a player).
 *
 * Usage:
 *   const panelRefreshBus = require('./core/panel-refresh-bus');
 *
 *   // in any service, after an action that changes a player's state:
 *   panelRefreshBus.requestRefresh(targetActorId, 'governance');
 *
 *   // in player-panel-service, once in initPlayerPanelService():
 *   panelRefreshBus.onRefresh((actorId, channel) => { ... });
 */

const { EventEmitter } = require('events');

const CHANNELS = new Set(['status', 'governance', 'economy', 'social']);

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * Asks for an actor's panel to be refreshed on a specific channel.
 * Does nothing if no listener is registered (e.g. the
 * player-panel module is disabled) or if the channel is unknown.
 * @param {number} actorId
 * @param {'status'|'governance'|'economy'|'social'} channel
 */
function requestRefresh(actorId, channel) {
  if (!CHANNELS.has(channel)) return;
  emitter.emit('refresh', actorId, channel);
}

/**
 * Registers a handler called on every requestRefresh().
 * @param {(actorId: number, channel: string) => void} handler
 */
function onRefresh(handler) {
  emitter.on('refresh', handler);
}

/**
 * Removes a handler registered with onRefresh().
 * @param {(actorId: number, channel: string) => void} handler
 */
function offRefresh(handler) {
  emitter.off('refresh', handler);
}

module.exports = { CHANNELS, requestRefresh, onRefresh, offRefresh };
