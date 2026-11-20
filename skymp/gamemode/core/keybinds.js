/**
 * core/keybinds.js
 *
 * Per-account keybinds: which DirectInput scan code triggers each client
 * action. The server is the authority (validates and persists in
 * `account_keybinds`, migration v30); the client only receives the resolved
 * map and dispatches key presses (see player-shortcuts-service.js).
 *
 * Scan codes are SkyrimPlatform `DxScanCode` values
 * (Data/Platform/Modules/skyrimPlatform.ts), which is what `buttonEvent.code`
 * carries. The UI keeps its own label/DOM table in skymp/ui/keybinds.js; a
 * test asserts both sides agree on action ids and codes.
 */

'use strict';

/**
 * Order is the order shown in the Controls tab.
 * `defaultCode: null` = unbound by default.
 */
const ACTIONS = Object.freeze([
  Object.freeze({ id: 'panel.open', defaultCode: 60 }),        // F2
  Object.freeze({ id: 'voice.pushToTalk', defaultCode: 47 }),  // V (hold to talk)
  Object.freeze({ id: 'voice.cycleMode', defaultCode: 87 }),   // F11
  Object.freeze({ id: 'voice.toggleMute', defaultCode: null }),
  Object.freeze({ id: 'chat.open', defaultCode: 28 }),        // Enter
  // Staff only: the client snippet opens the F8 admin panel only for players
  // the server marked as staff; for everyone else the key does nothing.
  Object.freeze({ id: 'admin.open', defaultCode: 66 })        // F8
]);

const ACTION_IDS = Object.freeze(ACTIONS.map(a => a.id));

/**
 * Keyboard scan codes a player may bind (DxScanCode, keyboard range only).
 * Escape (1) and the console key (41) are deliberately absent: binding them
 * would fight the game's own menu/console handling.
 */
const BINDABLE_CODES = Object.freeze(new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11,             // 1..0
  12, 13, 14, 15,                             // - = Backspace Tab
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25,     // Q..P
  26, 27, 28, 29,                             // [ ] Enter LCtrl
  30, 31, 32, 33, 34, 35, 36, 37, 38,         // A..L
  39, 40, 42, 43,                             // ; ' LShift \
  44, 45, 46, 47, 48, 49, 50,                 // Z..M
  51, 52, 53, 54, 55, 56, 57, 58,             // , . / RShift Num* LAlt Space Caps
  59, 60, 61, 62, 63, 64, 65, 66, 67, 68,     // F1..F10
  69, 70,                                     // NumLock ScrollLock
  71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, // numpad
  87, 88,                                     // F11 F12
  156, 157, 181, 183, 184, 197,               // NumEnter RCtrl Num/ PrtSc RAlt Pause
  199, 200, 201, 203, 205, 207, 208, 209, 210, 211 // Home..Delete, arrows
]));

const MAX_JSON_LENGTH = 2000;

class KeybindValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeybindValidationError';
  }
}

function defaultBindings() {
  const out = {};
  for (const action of ACTIONS) out[action.id] = action.defaultCode;
  return out;
}

/**
 * Strict validation for a player's save request. Every action must be
 * present, each value a bindable code or null, and no two actions may share
 * a key (one press would fire both).
 *
 * @param {unknown} input
 * @returns {Record<string, number|null>}
 */
function validateBindings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new KeybindValidationError('Keybinds must be an object.');
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!ACTION_IDS.includes(key)) throw new KeybindValidationError(`Unknown action: ${key}`);
  }
  const out = {};
  const used = new Map();
  for (const id of ACTION_IDS) {
    if (!Object.hasOwn(input, id)) throw new KeybindValidationError(`Missing action: ${id}`);
    const value = input[id];
    if (value === null) { out[id] = null; continue; }
    if (!Number.isInteger(value) || !BINDABLE_CODES.has(value)) {
      throw new KeybindValidationError(`Key not allowed for ${id}.`);
    }
    if (used.has(value)) {
      throw new KeybindValidationError(`${id} and ${used.get(value)} use the same key.`);
    }
    used.set(value, id);
    out[id] = value;
  }
  return out;
}

/**
 * Lenient merge for what comes back from the database: unknown actions are
 * dropped, invalid values fall back to the default, and actions added after
 * the row was saved get their default unless that key is already taken (then
 * they start unbound). Never throws.
 *
 * @param {unknown} stored
 * @returns {Record<string, number|null>}
 */
function resolveStoredBindings(stored) {
  const defaults = defaultBindings();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;

  const out = {};
  const used = new Set();
  // Pass 1: keep the player's own valid, non-conflicting choices.
  for (const id of ACTION_IDS) {
    if (!Object.hasOwn(stored, id)) continue;
    const value = stored[id];
    if (value === null) { out[id] = null; continue; }
    if (Number.isInteger(value) && BINDABLE_CODES.has(value) && !used.has(value)) {
      out[id] = value;
      used.add(value);
    }
  }
  // Pass 2: defaults for anything missing/invalid, unless the key is taken.
  for (const id of ACTION_IDS) {
    if (Object.hasOwn(out, id)) continue;
    const fallback = defaults[id];
    out[id] = fallback !== null && !used.has(fallback) ? fallback : null;
    if (out[id] !== null) used.add(out[id]);
  }
  return out;
}

/**
 * @param {{query:(sql:string, params:any[])=>Promise<any[]>}} db
 * @param {number} accountId
 */
async function loadAccountBindings(db, accountId) {
  const rows = await db.query(
    'SELECT bindings_json FROM account_keybinds WHERE account_id = ? LIMIT 1',
    [accountId]
  );
  if (!rows || rows.length === 0) return defaultBindings();
  let parsed = null;
  try { parsed = JSON.parse(rows[0].bindings_json); } catch { parsed = null; }
  return resolveStoredBindings(parsed);
}

/**
 * @param {{query:(sql:string, params:any[])=>Promise<any>}} db
 * @param {number} accountId
 * @param {Record<string, number|null>} bindings - already validated
 */
async function saveAccountBindings(db, accountId, bindings) {
  const json = JSON.stringify(bindings);
  if (json.length > MAX_JSON_LENGTH) throw new KeybindValidationError('Keybinds too large.');
  await db.query(
    `INSERT INTO account_keybinds (account_id, bindings_json) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE bindings_json = VALUES(bindings_json)`,
    [accountId, json]
  );
}

/**
 * @param {{query:(sql:string, params:any[])=>Promise<any>}} db
 * @param {number} accountId
 */
async function resetAccountBindings(db, accountId) {
  await db.query('DELETE FROM account_keybinds WHERE account_id = ?', [accountId]);
  return defaultBindings();
}

module.exports = {
  ACTIONS,
  ACTION_IDS,
  BINDABLE_CODES,
  KeybindValidationError,
  defaultBindings,
  validateBindings,
  resolveStoredBindings,
  loadAccountBindings,
  saveAccountBindings,
  resetAccountBindings
};
