/**
 * core/npc-respawn-delay.js — creatures and NPCs stay dead for hours, not seconds
 *
 * SkyMP respawns a dead actor after its `spawnDelay` (MpChangeForm, default
 * 25 s). The timer starts right after `mp.onDeath` runs (DeathEvent
 * OnFireSuccess -> RespawnWithDelay reads the delay then), so setting it from
 * a death subscriber applies to that very death. The value is saved with the
 * actor's change form, so it survives a server restart.
 *
 * Only world NPCs (ids from plugins, below 0xff000000) get the long delay.
 * Player characters are server-made actors (0xff…) and keep their own flow
 * (death-service.js).
 *
 * NPC_RESPAWN_HOURS (real hours, default 6) overrides the delay.
 */

const deathEvents = require('./death-events');

const DEFAULT_HOURS = 6;
const SERVER_MADE_FORMS = 0xff000000;
const SUBSCRIBER = 'npc-respawn-delay';

function respawnSeconds(env = process.env) {
  const hours = Number(env.NPC_RESPAWN_HOURS);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS) * 3600);
}

function isWorldNpc(actorId) {
  return Number.isInteger(actorId) && actorId > 0 && actorId < SERVER_MADE_FORMS;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.mpApi] the SkyMP `mp` object
 * @param {object} [opts.events] death-events (injectable for tests)
 */
function start({ mpApi = globalThis.mp, events = deathEvents, logger = console, env = process.env } = {}) {
  const seconds = respawnSeconds(env);
  events.subscribe(SUBSCRIBER, (actorId) => {
    if (!isWorldNpc(actorId) || !mpApi) return undefined;
    try {
      mpApi.set(actorId, 'spawnDelay', seconds);
    } catch (err) {
      logger.error(`[npc-respawn] Could not set the respawn delay of ${actorId.toString(16)}: ${err.message}`);
    }
    return undefined; // never block the native respawn, only delay it
  });
  logger.log(`[npc-respawn] Dead creatures and NPCs respawn after ${seconds / 3600} h.`);
  return seconds;
}

function stop({ events = deathEvents } = {}) {
  events.unsubscribe(SUBSCRIBER);
}

module.exports = { start, stop, respawnSeconds, isWorldNpc, DEFAULT_HOURS };
