/**
 * discordAccess.js
 *
 * Discord roles → whitelist and staff in the database. Staff give the
 * whitelist and staff roles on Discord; this keeps `whitelist_applications`
 * and `staff_roles` in step, so nobody has to edit them by hand.
 *
 * Runs when a player signs in to the panel or the launcher, and every time the
 * launcher asks for a launch ticket (each press of Play), so a role given or
 * taken on Discord counts at the player's next Play.
 *
 * Rules:
 * - The bot answers (`apps/bot-discord/memberAccess.js`). If it cannot be
 *   reached, nothing changes: a Discord outage must not cost anyone access.
 * - Whitelist: the Discord role grants it (an approved application, marked as
 *   coming from Discord). Losing the role does not take it away; staff use the
 *   panel for that, as before.
 * - Staff: rows this sync created carry `notes = DISCORD_NOTE`. Only those are
 *   changed or removed when the Discord role changes (Founder → owner included).
 *   A role set by hand in the database is never touched, so an owner set there
 *   cannot be removed from Discord.
 * - Every change goes to `audit_logs`.
 */

const DISCORD_NOTE = 'discord-role';
/** Staff roles the game knows (skymp/gamemode/admin-service.js ROLE_PERMISSIONS). */
const STAFF_ROLES = Object.freeze(['moderator', 'admin', 'owner']);
const BOT_TIMEOUT_MS = 3000;

/**
 * Asks the bot what the member's Discord roles grant.
 * @returns {Promise<{inGuild: boolean, whitelisted: boolean, staffRole: string|null}|null>} null when unknown
 */
async function fetchMemberAccess({ botUrl, secret, discordId, fetchImpl = fetch, timeoutMs = BOT_TIMEOUT_MS }) {
  if (!botUrl || !secret || !discordId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${botUrl}/api/member-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ discord_id: String(discordId) }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.inGuild !== 'boolean') return null;
    return {
      inGuild: body.inGuild,
      whitelisted: body.whitelisted === true,
      staffRole: STAFF_ROLES.includes(body.staffRole) ? body.staffRole : null
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Applies a member's Discord access to their account.
 *
 * @param {object} opts
 * @param {(sql: string, params?: any[]) => Promise<any[]>} opts.db  rows for SELECT
 * @param {(sql: string, params?: any[]) => Promise<any>} opts.execute  writes
 * @param {number} opts.accountId
 * @param {object|null} opts.access  output of fetchMemberAccess (null = unknown)
 * @returns {Promise<{ synced: boolean, changes: string[] }>}
 */
async function applyMemberAccess({ db, execute, accountId, access }) {
  const changes = [];
  if (!access || !Number.isInteger(Number(accountId))) return { synced: false, changes };
  const audit = (action, details) => execute(
    'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
    [action, null, accountId, JSON.stringify({ source: 'discord', ...details })]
  );

  if (access.whitelisted) {
    const approved = await db("SELECT id FROM whitelist_applications WHERE account_id = ? AND status = 'approved' LIMIT 1", [accountId]);
    if (!approved.length) {
      await execute(
        "INSERT INTO whitelist_applications (account_id, status, reviewed_by, reviewer_notes, reviewed_at) VALUES (?, 'approved', 'discord', ?, NOW())",
        [accountId, 'Whitelisted by Discord role']
      );
      await audit('whitelist:discord_grant', {});
      changes.push('whitelisted');
    }
  }

  const wanted = access.inGuild ? access.staffRole : null;
  const rows = await db('SELECT role, notes FROM staff_roles WHERE account_id = ? LIMIT 1', [accountId]);
  const current = rows[0] || null;
  const managed = Boolean(current && current.notes === DISCORD_NOTE);

  if (!current && wanted) {
    await execute('INSERT INTO staff_roles (account_id, role, notes) VALUES (?, ?, ?)', [accountId, wanted, DISCORD_NOTE]);
    await audit('staff:discord_grant', { role: wanted });
    changes.push(`staff:${wanted}`);
  } else if (managed && wanted && current.role !== wanted) {
    await execute('UPDATE staff_roles SET role = ? WHERE account_id = ? AND notes = ?', [wanted, accountId, DISCORD_NOTE]);
    await audit('staff:discord_change', { from: current.role, to: wanted });
    changes.push(`staff:${current.role}->${wanted}`);
  } else if (managed && !wanted) {
    await execute('DELETE FROM staff_roles WHERE account_id = ? AND notes = ?', [accountId, DISCORD_NOTE]);
    await audit('staff:discord_revoke', { role: current.role });
    changes.push('staff:removed');
  }

  return { synced: true, changes };
}

/**
 * fetch + apply, never throws: signing in or pressing Play must not fail
 * because the sync did.
 */
async function syncDiscordAccess({ db, execute, accountId, discordId, botUrl, secret, fetchImpl, logger = console }) {
  try {
    const access = await fetchMemberAccess({ botUrl, secret, discordId, fetchImpl });
    const result = await applyMemberAccess({ db, execute, accountId, access });
    if (result.changes.length) logger.log(`[discord-access] account ${accountId}: ${result.changes.join(', ')}`);
    return result;
  } catch (err) {
    logger.error('[discord-access] sync failed:', err.message);
    return { synced: false, changes: [] };
  }
}

module.exports = { DISCORD_NOTE, fetchMemberAccess, applyMemberAccess, syncDiscordAccess };
