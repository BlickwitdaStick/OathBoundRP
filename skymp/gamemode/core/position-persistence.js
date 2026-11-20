/**
 * core/position-persistence.js — characters log back in where they logged out
 *
 * `whitelist.js` moves every character, at login, to characters.pos_x/y/z +
 * cell_id. Nothing ever wrote those columns, so everyone always reappeared at
 * the default spawn. This service writes them:
 *
 * - every TICK_MS for each online character, only when the position changed;
 * - once more when the character disconnects (best effort: the actor may
 *   already be gone, and then the last tick's value stands).
 *
 * A character is only saved after `markRestored(actorId)` — called by
 * whitelist.js right after it applied the saved location. Before that the
 * actor sits at SkyMP's start point for a moment, and saving it then would
 * overwrite the real position with the default spawn.
 */

const TICK_MS = 30000;
/** Below this many game units of movement a save is skipped (about 1.5 m). */
const MIN_MOVE = 100;

function createPositionPersistence({ db, mpApi, listActive, getCharacter, logger = console }) {
  /** actorId -> last saved {x,y,z,cell} */
  const lastSaved = new Map();
  /** actorIds whose saved location was applied at login */
  const restored = new Set();
  let timer = null;

  function read(actorId) {
    let loc;
    try { loc = mpApi.get(actorId, 'locationalData'); } catch { return null; }
    if (!loc || !Array.isArray(loc.pos) || loc.pos.length !== 3) return null;
    const [x, y, z] = loc.pos.map(Number);
    const cell = loc.cellOrWorldDesc != null ? String(loc.cellOrWorldDesc) : null;
    if (![x, y, z].every(Number.isFinite) || !cell) return null;
    const angle = Array.isArray(loc.rot) && Number.isFinite(Number(loc.rot[2])) ? Number(loc.rot[2]) : 0;
    return { x, y, z, angle, cell };
  }

  function changed(prev, cur) {
    if (!prev) return true;
    if (prev.cell !== cur.cell) return true;
    return Math.hypot(prev.x - cur.x, prev.y - cur.y, prev.z - cur.z) >= MIN_MOVE;
  }

  async function save(actorId, { force = false } = {}) {
    if (!restored.has(actorId)) return false;
    const char = getCharacter(actorId);
    if (!char || !char.characterId) return false;
    const cur = read(actorId);
    if (!cur) return false;
    if (!force && !changed(lastSaved.get(actorId), cur)) return false;
    await db.query(
      'UPDATE characters SET pos_x = ?, pos_y = ?, pos_z = ?, angle_z = ?, cell_id = ? WHERE id = ?',
      [cur.x, cur.y, cur.z, cur.angle, cur.cell.slice(0, 64), char.characterId]
    );
    lastSaved.set(actorId, cur);
    return true;
  }

  async function tick() {
    for (const actorId of listActive()) {
      try { await save(actorId); } catch (err) {
        logger.error(`[position] Could not save position of ${actorId.toString(16)}:`, err.message);
      }
    }
  }

  return {
    TICK_MS,
    /** Called by whitelist.js after applying the saved location. */
    markRestored(actorId) { restored.add(actorId); },
    /** Called on disconnect, before the character leaves the active list. */
    onDisconnect(actorId) {
      // `save` reads the character and the position synchronously, before its
      // first await, so this works even though the caller forgets the
      // character right after. The bookkeeping is cleared synchronously too:
      // a quick reconnect on the same actorId must not lose its new mark.
      const pending = save(actorId, { force: true });
      restored.delete(actorId);
      lastSaved.delete(actorId);
      return pending.catch((err) => {
        logger.error(`[position] Could not save position on logout of ${actorId.toString(16)}:`, err.message);
      });
    },
    tick,
    save,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

let _instance = null;

/** Shared instance for the running server (lazy: needs `mp` and the db). */
function getInstance() {
  if (!_instance) {
    const db = require('../database');
    const commands = require('../commands');
    _instance = createPositionPersistence({
      db,
      mpApi: { get: (id, k) => mp.get(id, k) },
      listActive: () => commands.listActiveActorIds(),
      getCharacter: (id) => commands.getActiveCharacterData(id)
    });
  }
  return _instance;
}

module.exports = { createPositionPersistence, getInstance, TICK_MS, MIN_MOVE };
