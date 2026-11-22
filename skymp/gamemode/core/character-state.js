/**
 * core/character-state.js
 *
 * Character state machine.
 *
 * Possible states:
 *   NORMAL      - No restrictions
 *   BUSY        - In a channeled animation (mining, fishing, etc.)
 *   DOWNED      - Downed, waiting for help (persisted in the DB)
 *   DEAD        - Dead (transition to DOWNED after stabilization fails)
 *   RESTRAINED  - Cuffed/tied (persisted in the DB via character_restraints)
 *   SURRENDERED - Surrendered voluntarily (session; see core/crime-service.js
 *                 `crime.surrender` — vulnerable to `crime.rob` while it lasts)
 *   IMPRISONED  - In prison (persisted in the DB via prison_records)
 *   IN_TRADE    - Trading with another player
 *   IN_CRAFT    - In the middle of crafting
 *   IN_DIALOG   - In a dialogue/menu with an NPC or system
 *   DISCONNECTED - Session ended (removed from the in-memory cache)
 *
 * Persistence strategy:
 *   - SESSION states (BUSY, IN_TRADE, IN_CRAFT, IN_DIALOG): memory only.
 *     Reset automatically on disconnect.
 *   - DURABLE states (IMPRISONED, RESTRAINED, DOWNED): loaded from the DB on login,
 *     persisted immediately when set.
 */

const db = require('../database');

// Valid states
const STATES = Object.freeze({
  NORMAL:       'NORMAL',
  BUSY:         'BUSY',
  DOWNED:       'DOWNED',
  DEAD:         'DEAD',
  RESTRAINED:   'RESTRAINED',
  SURRENDERED:  'SURRENDERED',
  IMPRISONED:   'IMPRISONED',
  IN_TRADE:     'IN_TRADE',
  IN_CRAFT:     'IN_CRAFT',
  IN_DIALOG:    'IN_DIALOG',
  DISCONNECTED: 'DISCONNECTED'
});

// States that survive restarts (loaded from the DB on login)
const DURABLE_STATES = new Set([STATES.IMPRISONED, STATES.RESTRAINED, STATES.DOWNED]);

// In-memory cache: characterId → { state, metadata, setAt }
const _stateCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads a character's durable state from the database.
 * Called on login (whitelist.js).
 * @param {number} characterId
 * @returns {Promise<{state: string, metadata: object}>}
 */
async function _loadDurableState(characterId) {
  try {
    // Check for an active prison sentence
    const imprisoned = await db.query(
      `SELECT id, crime_summary, sentence_minutes, time_served_minutes, cell_id
       FROM prison_records
       WHERE character_id = ? AND status = 'active'
       ORDER BY arrested_at DESC LIMIT 1`,
      [characterId]
    );
    if (imprisoned.length > 0) {
      return { state: STATES.IMPRISONED, metadata: imprisoned[0] };
    }

    // Verifica algemas ativas
    const restrained = await db.query(
      `SELECT type, restrained_by_character_id, applied_at
       FROM character_restraints
       WHERE character_id = ?`,
      [characterId]
    );
    if (restrained.length > 0) {
      return { state: STATES.RESTRAINED, metadata: restrained[0] };
    }

    // Default state
    return { state: STATES.NORMAL, metadata: {} };
  } catch (err) {
    console.error(`[character-state] Error loading durable state for char ${characterId}:`, err.message);
    return { state: STATES.NORMAL, metadata: {} };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initializes a character's state when they join the server.
 * Loads durable states from the database.
 * @param {number} characterId
 * @returns {Promise<string>} Initial state
 */
async function initialize(characterId) {
  const { state, metadata } = await _loadDurableState(characterId);
  _stateCache.set(characterId, { state, metadata, setAt: Date.now() });
  console.log(`[character-state] char=${characterId} inicializado como ${state}`);
  return state;
}

/**
 * Returns a character's current state.
 * @param {number} characterId
 * @returns {string} Current state, or NORMAL if not found
 */
function get(characterId) {
  const entry = _stateCache.get(characterId);
  return entry ? entry.state : STATES.NORMAL;
}

/**
 * Returns the metadata of the current state.
 * @param {number} characterId
 * @returns {object}
 */
function getMetadata(characterId) {
  const entry = _stateCache.get(characterId);
  return entry ? entry.metadata : {};
}

/**
 * Checks whether the character is in a specific state.
 * @param {number} characterId
 * @param {string|string[]} states - State or list of states
 * @returns {boolean}
 */
function is(characterId, states) {
  const current = get(characterId);
  if (Array.isArray(states)) return states.includes(current);
  return current === states;
}

/**
 * Sets a character's state.
 * Durable states (IMPRISONED, RESTRAINED, DOWNED) are persisted to the DB automatically by
 * their own services (governance-service, death-service). This method only updates the cache.
 *
 * @param {number} characterId
 * @param {string} newState - One of the valid STATES
 * @param {object} [metadata] - Extra data about the state
 */
function set(characterId, newState, metadata = {}) {
  if (!/** @type {any} */ (Object.values(STATES)).includes(newState)) {
    throw new Error(`[character-state] Invalid state: ${newState}`);
  }
  const previous = get(characterId);
  _stateCache.set(characterId, { state: newState, metadata, setAt: Date.now() });
  console.log(`[character-state] char=${characterId}: ${previous} → ${newState}`);
}

/**
 * Resets a character's state to NORMAL (session states only).
 * Does not touch durable states, which must be resolved by their own services.
 * @param {number} characterId
 */
function reset(characterId) {
  const current = get(characterId);
  if (!/** @type {any} */ (DURABLE_STATES).has(current)) {
    set(characterId, STATES.NORMAL, {});
  } else {
    console.log(`[character-state] char=${characterId} keeps durable state ${current} on reset`);
  }
}

/**
 * Removes the character from the cache on disconnect.
 * Durable states are already in the database.
 * @param {number} characterId
 */
function cleanup(characterId) {
  _stateCache.delete(characterId);
  console.log(`[character-state] char=${characterId} removido do cache`);
}

module.exports = { STATES, DURABLE_STATES, initialize, get, getMetadata, is, set, reset, cleanup };
