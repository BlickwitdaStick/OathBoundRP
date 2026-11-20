/**
 * core/position-persistence.js — characters log back in where they logged out
 *
 * `whitelist.js` moves every character, at login, to characters.pos_x/y/z +
 * cell_id. This service keeps those columns current:
 *
 * - every TICK_MS it reads each online character's position and remembers it
 *   (`lastSeen`); it writes to the database only when the character moved
 *   MIN_MOVE or changed cell;
 * - on disconnect it writes the last REMEMBERED position. It does not read the
 *   actor at that point: the disconnect is noticed by polling, seconds later,
 *   and by then SkyMP may have reset the actor to its start point (or the
 *   player already reconnected and stands there). Reading it then saved the
 *   start point over the real position — everyone came back in Riverwood.
 *
 * Two more guards:
 * - nothing is saved before `markRestored(actorId)` (whitelist.js calls it
 *   right after applying the saved location; before that the actor is at the
 *   start point);
 * - a position at SkyMP's start point (server-settings.json `startPoints`) is
 *   never saved. Nobody logs out exactly there, and every bad save so far
 *   was exactly there.
 */

const fs = require('fs');
const path = require('path');

const TICK_MS = 10000;
/** Below this many game units of movement a save is skipped (about 1.5 m). */
const MIN_MOVE = 100;
/** Within this distance of the start point (same cell) a position is ignored. */
const START_POINT_RADIUS = 64;

/** '0x162e2', '162E2', '162e2:Skyrim.esm' -> '162e2' (plugin-less, for comparison). */
function normalizeCell(cell) {
  if (cell == null) return null;
  return String(cell).trim().toLowerCase().replace(/^0x/, '').replace(/:skyrim\.esm$/, '');
}

/** SkyMP start points from server-settings.json, as [{pos:[x,y,z], cell}]. */
function loadStartPoints(settingsPath) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
    const list = Array.isArray(s.startPoints) ? s.startPoints : (s.startPoints ? [s.startPoints] : []);
    return list
      .filter((p) => p && Array.isArray(p.pos) && p.pos.length === 3)
      .map((p) => ({ pos: p.pos.map(Number), cell: normalizeCell(p.worldOrCell) }));
  } catch {
    return [];
  }
}

function createPositionPersistence({ db, mpApi, listActive, getCharacter, startPoints = [], logger = console }) {
  /** actorId -> last written {x,y,z,angle,cell} */
  const lastSaved = new Map();
  /** actorId -> last good position read while online */
  const lastSeen = new Map();
  /** actorIds whose saved location was applied at login */
  const restored = new Set();
  let timer = null;

  function atStartPoint(cur) {
    const cell = normalizeCell(cur.cell);
    return startPoints.some((sp) => (!sp.cell || sp.cell === cell) &&
      Math.hypot(sp.pos[0] - cur.x, sp.pos[1] - cur.y, sp.pos[2] - cur.z) <= START_POINT_RADIUS);
  }

  function read(actorId) {
    let loc;
    try { loc = mpApi.get(actorId, 'locationalData'); } catch { return null; }
    if (!loc || !Array.isArray(loc.pos) || loc.pos.length !== 3) return null;
    const [x, y, z] = loc.pos.map(Number);
    const cell = loc.cellOrWorldDesc != null ? String(loc.cellOrWorldDesc) : null;
    if (![x, y, z].every(Number.isFinite) || !cell) return null;
    const angle = Array.isArray(loc.rot) && Number.isFinite(Number(loc.rot[2])) ? Number(loc.rot[2]) : 0;
    const cur = { x, y, z, angle, cell };
    return atStartPoint(cur) ? null : cur;
  }

  function changed(prev, cur) {
    if (!prev) return true;
    if (prev.cell !== cur.cell) return true;
    return Math.hypot(prev.x - cur.x, prev.y - cur.y, prev.z - cur.z) >= MIN_MOVE;
  }

  async function write(characterId, actorId, cur) {
    await db.query(
      'UPDATE characters SET pos_x = ?, pos_y = ?, pos_z = ?, angle_z = ?, cell_id = ? WHERE id = ?',
      [cur.x, cur.y, cur.z, cur.angle, cur.cell.slice(0, 64), characterId]
    );
    lastSaved.set(actorId, cur);
  }

  /** Reads the live position, remembers it, and writes it if it moved. */
  async function save(actorId) {
    if (!restored.has(actorId)) return false;
    const char = getCharacter(actorId);
    if (!char || !char.characterId) return false;
    const cur = read(actorId);
    if (!cur) return false;
    lastSeen.set(actorId, cur);
    if (!changed(lastSaved.get(actorId), cur)) return false;
    await write(char.characterId, actorId, cur);
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
    markRestored(actorId) {
      restored.add(actorId);
      lastSeen.delete(actorId);
      lastSaved.delete(actorId);
    },
    /**
     * Called on disconnect, while the character is still known. Writes the
     * last position seen while online; never reads the actor now.
     */
    onDisconnect(actorId) {
      const char = getCharacter(actorId);
      const seen = lastSeen.get(actorId);
      const wasRestored = restored.has(actorId);
      restored.delete(actorId);
      lastSeen.delete(actorId);
      const prev = lastSaved.get(actorId);
      lastSaved.delete(actorId);
      const identical = prev && prev.x === seen.x && prev.y === seen.y && prev.z === seen.z &&
        prev.cell === seen.cell && prev.angle === seen.angle;
      if (!wasRestored || !char || !char.characterId || !seen || identical) {
        return Promise.resolve(false);
      }
      return write(char.characterId, actorId, seen).then(() => { lastSaved.delete(actorId); return true; }, (err) => {
        logger.error(`[position] Could not save position on logout of ${actorId.toString(16)}:`, err.message);
        return false;
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
    // The server runs with skymp/server as working directory.
    const settingsPath = path.resolve(process.cwd(), 'server-settings.json');
    const startPoints = loadStartPoints(settingsPath);
    if (startPoints.length === 0) console.warn(`[position] No startPoints read from ${settingsPath}; the start-point guard is off.`);
    _instance = createPositionPersistence({
      db,
      mpApi: { get: (id, k) => mp.get(id, k) },
      listActive: () => commands.listActiveActorIds(),
      getCharacter: (id) => commands.getActiveCharacterData(id),
      startPoints
    });
  }
  return _instance;
}

module.exports = { createPositionPersistence, getInstance, loadStartPoints, normalizeCell, TICK_MS, MIN_MOVE, START_POINT_RADIUS };
