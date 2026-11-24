/**
 * memberAccess.js
 *
 * Discord is where staff hand out the whitelist and staff roles. This module
 * turns a member's Discord role ids into what the game cares about:
 *
 *   { whitelisted: boolean, staffRole: 'owner' | 'admin' | 'moderator' | null }
 *
 * The panel (`apps/web/discordAccess.js`) asks the bot through
 * `POST /api/member-access` when a player signs in or presses Play, and writes
 * the result into `whitelist_applications` and `staff_roles`.
 *
 * Configuration (bot .env):
 *   STAFF_ROLE_MAP      roleId:staffRole pairs, staffRole = owner | admin | moderator
 *   WHITELIST_ROLE_IDS  roles that count as whitelisted (comma-separated);
 *                       falls back to WHITELIST_ROLE_ID. Every role in
 *                       STAFF_ROLE_MAP is whitelisted too: staff can always play.
 *
 * Pure functions, so the rules are tested without Discord.
 */

/** Staff roles a Discord role may grant, weakest first. */
const GRANTABLE_STAFF_ROLES = Object.freeze(['moderator', 'admin', 'owner']);

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/**
 * Reads `STAFF_ROLE_MAP`: comma-separated `discordRoleId:staffRole` pairs,
 * e.g. `111111111111111111:owner,222222222222222222:admin`.
 * Bad pairs are skipped and reported, never guessed.
 *
 * @returns {{ map: Map<string, string>, errors: string[] }}
 */
function parseStaffRoleMap(raw) {
  const map = new Map();
  const errors = [];
  for (const part of String(raw || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [id, role] = part.split(':').map((s) => (s || '').trim());
    if (!isSnowflake(id)) { errors.push(`"${part}": not a Discord role id`); continue; }
    if (!GRANTABLE_STAFF_ROLES.includes(role)) {
      errors.push(`"${part}": staff role must be ${GRANTABLE_STAFF_ROLES.join(', ')}`);
      continue;
    }
    map.set(id, role);
  }
  return { map, errors };
}

/** Comma-separated role ids; bad ones are reported. */
function parseRoleIdList(raw) {
  const ids = new Set();
  const errors = [];
  for (const part of String(raw || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    if (isSnowflake(part)) ids.add(part);
    else errors.push(`"${part}": not a Discord role id`);
  }
  return { ids, errors };
}

/**
 * The staff role map from the environment. `STAFF_ROLE_MAP` wins; without it,
 * the existing `STAFF_ROLE_ID` (used by the voice commands) grants moderator.
 */
function staffRoleMapFromEnv(env = process.env) {
  if (env.STAFF_ROLE_MAP && env.STAFF_ROLE_MAP.trim()) return parseStaffRoleMap(env.STAFF_ROLE_MAP);
  if (isSnowflake(env.STAFF_ROLE_ID)) return { map: new Map([[env.STAFF_ROLE_ID, 'moderator']]), errors: [] };
  return { map: new Map(), errors: [] };
}

/** Whitelist roles from the environment: WHITELIST_ROLE_IDS, else WHITELIST_ROLE_ID. */
function whitelistRoleIdsFromEnv(env = process.env) {
  if (env.WHITELIST_ROLE_IDS && env.WHITELIST_ROLE_IDS.trim()) return parseRoleIdList(env.WHITELIST_ROLE_IDS);
  return parseRoleIdList(env.WHITELIST_ROLE_ID || '');
}

/**
 * @param {Iterable<string>} roleIds   the member's Discord role ids
 * @param {{ whitelistRoleIds?: Iterable<string>, staffRoleMap?: Map<string, string> }} config
 */
function accessFor(roleIds, { whitelistRoleIds = [], staffRoleMap = new Map() } = {}) {
  const ids = new Set(roleIds || []);
  let staffRole = null;
  for (const [id, role] of staffRoleMap) {
    if (!ids.has(id)) continue;
    if (!staffRole || GRANTABLE_STAFF_ROLES.indexOf(role) > GRANTABLE_STAFF_ROLES.indexOf(staffRole)) staffRole = role;
  }
  const whitelisted = Boolean(staffRole) || [...whitelistRoleIds].some((id) => ids.has(id));
  return { whitelisted, staffRole };
}

module.exports = {
  GRANTABLE_STAFF_ROLES,
  isSnowflake,
  parseStaffRoleMap,
  parseRoleIdList,
  staffRoleMapFromEnv,
  whitelistRoleIdsFromEnv,
  accessFor
};
