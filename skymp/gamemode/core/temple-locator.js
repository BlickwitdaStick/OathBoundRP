/**
 * core/temple-locator.js
 *
 * Picks the temple a downed player wakes up in (death-service.js).
 *
 * The table is data/temple-data.json, built from Skyrim.esm by
 * tools/temples/build-temple-data.js. "Nearest" means:
 *
 *   1. In Tamriel or a city worldspace (they share Tamriel's coordinates):
 *      the temple whose front door is closest in a straight line.
 *   2. In a vanilla interior cell or another worldspace (Blackreach, a
 *      dungeon world): the temple the build found by walking load doors to the
 *      first exit into Tamriel.
 *   3. Anywhere else (a cell added by a mod): the temple nearest the last
 *      Tamriel position seen for that actor.
 *   4. Nothing known: the default temple (Whiterun).
 *
 * Cells are always handed out as a FormDesc ("165a7:Skyrim.esm"). A bare
 * "0x..." resolves to a server-generated form and freezes the player.
 */
'use strict';

const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'temple-data.json');

/**
 * "165a7:Skyrim.esm" -> 0x165a7 for Skyrim.esm descs, null otherwise. The
 * table only knows Skyrim.esm forms.
 */
function skyrimIdFromDesc(desc) {
  const m = /^(?:0x)?([0-9a-f]{1,8}):(.+)$/i.exec(String(desc || '').trim());
  if (!m || m[2].trim().toLowerCase() !== 'skyrim.esm') return null;
  return parseInt(m[1], 16);
}

function loadTempleData(file = DATA_PATH) {
  return require(file);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.data] parsed temple-data.json
 * @param {object} [opts.logger]
 */
function createTempleLocator({ data = loadTempleData(), logger = console } = {}) {
  let temples = data.temples.slice();
  const tamrielWorlds = new Set(data.tamrielWorlds.map((h) => parseInt(h, 16)));
  const templeByCell = new Map();
  for (const [key, cells] of Object.entries(data.cellsByTemple || {})) {
    for (const c of cells) templeByCell.set(parseInt(c, 16), key);
  }
  /** actorId -> last [x, y, z] seen in a Tamriel-frame worldspace */
  const lastExterior = new Map();

  const byKey = (key) => temples.find((t) => t.key === key) || null;
  const fallback = () => byKey(data.defaultTemple) || temples[0] || null;

  function nearestTo(pos) {
    let best = null;
    let bestD = Infinity;
    for (const t of temples) {
      const d = Math.hypot(pos[0] - t.exterior.pos[0], pos[1] - t.exterior.pos[1]);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  function validPos(pos) {
    return Array.isArray(pos) && pos.length >= 2 && pos.slice(0, 3).every((n) => Number.isFinite(Number(n)));
  }

  /**
   * Records where the actor is, so a later fall inside an unknown cell can
   * still find the nearest temple. Call it from a periodic poll.
   */
  function remember(actorId, loc) {
    if (!loc || !validPos(loc.pos)) return;
    const id = skyrimIdFromDesc(loc.cellOrWorldDesc);
    if (id !== null && tamrielWorlds.has(id)) lastExterior.set(actorId, loc.pos.map(Number));
  }

  function forget(actorId) {
    lastExterior.delete(actorId);
  }

  /**
   * @param {{cellOrWorldDesc: string, pos: number[]}|null} loc where the actor fell
   * @param {number} [actorId] for the last-exterior fallback
   * @returns {{temple: object, reason: string}|null}
   */
  function nearestTemple(loc, actorId) {
    if (!temples.length) return null;
    const id = loc ? skyrimIdFromDesc(loc.cellOrWorldDesc) : null;
    if (id !== null && tamrielWorlds.has(id) && validPos(loc.pos)) {
      return { temple: nearestTo(loc.pos.map(Number)), reason: 'distance' };
    }
    if (id !== null && templeByCell.has(id)) {
      const t = byKey(templeByCell.get(id));
      if (t) return { temple: t, reason: 'cell' };
    }
    if (actorId !== undefined && lastExterior.has(actorId)) {
      return { temple: nearestTo(lastExterior.get(actorId)), reason: 'last-exterior' };
    }
    return { temple: fallback(), reason: 'default' };
  }

  /**
   * Drops every temple whose cell the running server does not know as a CELL
   * (checked with mp.lookupEspmRecordById). Returns the dropped keys. When
   * the lookup itself is missing or throws, the temple is kept: a broken
   * lookup must not leave the server with no temple at all.
   */
  function validate(mpApi) {
    if (!mpApi || typeof mpApi.lookupEspmRecordById !== 'function') return [];
    const dropped = [];
    temples = temples.filter((t) => {
      let type;
      try {
        const id = typeof mpApi.getIdFromDesc === 'function' ? mpApi.getIdFromDesc(t.cellDesc) : skyrimIdFromDesc(t.cellDesc);
        const r = mpApi.lookupEspmRecordById(id);
        type = r && r.record ? r.record.type : null;
        const edid = r && r.record ? r.record.editorId : undefined;
        if (type === 'CELL' && edid !== undefined && edid !== t.editorId) {
          logger.warn(`[temple-locator] ${t.cellDesc} is CELL ${edid}, expected ${t.editorId}`);
        }
      } catch (err) {
        logger.warn(`[temple-locator] could not look up ${t.cellDesc}: ${err.message}`);
        return true;
      }
      if (type === 'CELL') return true;
      dropped.push(t.key);
      logger.error(`[temple-locator] ${t.name} (${t.cellDesc}) is not a CELL on this server (got ${type || 'nothing'}); not using it`);
      return false;
    });
    return dropped;
  }

  return { nearestTemple, remember, forget, validate, temples: () => temples.slice() };
}

module.exports = { createTempleLocator, loadTempleData, skyrimIdFromDesc, DATA_PATH };
