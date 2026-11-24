/**
 * memberAccess.js
 *
 * Discord is where staff hand out the whitelist and staff roles. This module
 * turns a member's Discord role ids into what the game cares about:
 *
 *   { whitelisted: boolean, staffRole: 'admin' | 'moderator' | null }
 *
 * The panel (`apps/web/discordAccess.js`) asks the bot through
 * `POST /api/member-access` when a player signs in or presses Play, and writes
 * the result into `whitelist_applications` and `staff_roles`.
 *
 * `owner` can never come from Discord: a compromised or careless Discord admin
 * must not be able to hand out the one role that manages staff. Owners are set
 * in the database only, and the panel never touches an owner row.
 *
 * Pure functions, so the rules are tested without Discord.
 */

/** Staff roles a Discord role may grant, weakest first. */
const GRANTABLE_STAFF_ROLES = Object.freeze(['moderator', 'admin']);

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/**
 * Reads `STAFF_ROLE_MAP`: comma-separated `discordRoleId:staffRole` pairs,
 * e.g. `111111111111111111:admin,222222222222222222:moderator`.
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
      errors.push(`"${part}": staff role must be ${GRANTABLE_STAFF_ROLES.join(' or ')}`);
      continue;
    }
    map.set(id, role);
  }
  return { map, errors };
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

/**
 * @param {Iterable<string>} roleIds   the member's Discord role ids
 * @param {{ whitelistRoleId?: string, staffRoleMap?: Map<string, string> }} config
 */
function accessFor(roleIds, { whitelistRoleId = null, staffRoleMap = new Map() } = {}) {
  const ids = new Set(roleIds || []);
  let staffRole = null;
  for (const [id, role] of staffRoleMap) {
    if (!ids.has(id)) continue;
    if (!staffRole || GRANTABLE_STAFF_ROLES.indexOf(role) > GRANTABLE_STAFF_ROLES.indexOf(staffRole)) staffRole = role;
  }
  return {
    whitelisted: Boolean(whitelistRoleId && ids.has(whitelistRoleId)),
    staffRole
  };
}

module.exports = { GRANTABLE_STAFF_ROLES, isSnowflake, parseStaffRoleMap, staffRoleMapFromEnv, accessFor };
