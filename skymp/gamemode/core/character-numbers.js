/**
 * core/character-numbers.js — every character gets a short number (#1..#5000)
 *
 * Commands used to target people by SkyMP actorId (`/tp ff000a3c`): long, hex,
 * and different every session. A character number is short, permanent while
 * the character lives, and unique across the server, so `/tp 12` or `/trade #12`
 * always means the same person.
 *
 * - Assigned at login to the lowest free number (characters.char_number).
 * - Released when the character is retired, so the pool does not run out.
 * - Unique by database constraint; two logins racing for the same number make
 *   one INSERT fail with ER_DUP_ENTRY, and that one simply tries the next gap.
 *
 * Command arguments are rewritten in `commands.handleChatInput` (see
 * `resolveTargetArgs`): a usage slot named `<player#>` (or the legacy
 * `<actorId>`) accepts `12`, `#12`, or a raw `0x…` actorId for staff.
 */

const MAX_CHARACTER_NUMBER = 5000;

/** `12` / `#12` -> 12; anything else -> null. */
function parseCharacterNumber(token) {
  if (typeof token !== 'string') return null;
  const m = /^#?(\d{1,4})$/.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_CHARACTER_NUMBER ? n : null;
}

/** Lowest number in 1..MAX not in `taken` (sorted or not), or null when full. */
function lowestFree(taken) {
  const used = new Set(taken);
  for (let n = 1; n <= MAX_CHARACTER_NUMBER; n++) {
    if (!used.has(n)) return n;
  }
  return null;
}

/**
 * The character's number, assigning one if it has none.
 * @param {{query: Function}} db
 * @param {number} characterId
 * @param {number|null|undefined} current - characters.char_number already read at login
 * @returns {Promise<number|null>} null only when all 5000 numbers are in use
 */
async function ensureNumber(db, characterId, current) {
  if (Number.isInteger(current) && current >= 1 && current <= MAX_CHARACTER_NUMBER) return current;

  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db.query('SELECT char_number FROM characters WHERE char_number IS NOT NULL');
    const n = lowestFree(rows.map((r) => Number(r.char_number)));
    if (n === null) return null;
    try {
      const res = await db.query(
        'UPDATE characters SET char_number = ? WHERE id = ? AND char_number IS NULL',
        [n, characterId]
      );
      if (res && res.affectedRows === 0) {
        // Someone (another login of the same character) assigned it first.
        const [row] = await db.query('SELECT char_number FROM characters WHERE id = ?', [characterId]);
        return row && row.char_number ? Number(row.char_number) : null;
      }
      return n;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue; // raced for the same gap
      throw err;
    }
  }
  return null;
}

/** Frees a retired character's number for reuse. */
async function releaseNumber(db, characterId) {
  await db.query('UPDATE characters SET char_number = NULL WHERE id = ?', [characterId]);
}

/** Usage slots that name a player: `<player#>`, `<owner#>`, legacy `<actorId>`/`<ownerActorId>`. */
function isPlayerSlot(slot) {
  return /#|actorid/i.test(slot);
}

/**
 * Rewrites player slots in `args` from character numbers to `0x<actorId>`.
 *
 * @param {string} usage - e.g. '/fine <player#> <amount> <reason>'
 * @param {string} args - what the player typed after the command
 * @param {(n: number) => number|null} actorByNumber - online actor for a number
 * @returns {{args: string} | {error: string}}
 */
function resolveTargetArgs(usage, args, actorByNumber) {
  if (!usage || !args) return { args };
  const slots = (usage.match(/<[^>]+>|\[[^\]]+\]/g) || []);
  const words = args.split(/\s+/);
  for (let i = 0; i < slots.length && i < words.length; i++) {
    if (!isPlayerSlot(slots[i])) continue;
    const word = words[i];
    if (/^0x[0-9a-f]+$/i.test(word)) continue; // raw actorId (staff, logs)
    const n = parseCharacterNumber(word);
    if (n === null) {
      return { error: `"${word}" is not a character number. Use the player's number, e.g. 12 or #12 (see /nearby).` };
    }
    const actorId = actorByNumber(n);
    if (!actorId) return { error: `No one with number #${n} is online.` };
    words[i] = `0x${actorId.toString(16)}`;
  }
  return { args: words.join(' ') };
}

module.exports = {
  MAX_CHARACTER_NUMBER,
  parseCharacterNumber,
  lowestFree,
  ensureNumber,
  releaseNumber,
  isPlayerSlot,
  resolveTargetArgs
};
