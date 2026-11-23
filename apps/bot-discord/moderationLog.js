/**
 * moderationLog.js
 *
 * Sends moderation events to a Discord channel.
 *
 * `docs/ARCHITECTURE.md` 1.3 recorded this as the bot's original intent and
 * noted it was **never implemented** — until now the bot only exposed the role
 * sync and the voice commands.
 *
 * ─── The Discord channel is not the record ──────────────────────────────────
 *
 * The moderation record is `audit_logs`, written by the gamemode and the panel
 * in the same flow as the action. This channel is a **notification**: it lets
 * staff see things happen, on their phone, without opening the panel.
 *
 * That distinction decides the failure behavior: if Discord is down, the
 * moderation action **happens anyway** and nothing is undone. Whoever produces
 * the event fires and forgets; nobody waits for a reply from here, and a
 * `/permakill` never fails because the bot went down.
 *
 * ─── Why push and not polling audit_logs ────────────────────────────────────
 *
 * The alternative was for the bot to read `audit_logs` periodically — it even
 * already has `mysql2` in `dependencies` (unused). It was discarded: it would
 * hand database credentials to a third process to read a table it doesn't
 * write, in exchange for polling latency. Push sends from where the action
 * happens, the moment it happens, and the only secret that crosses over is the
 * `INTERNAL_API_SECRET` the panel already uses to talk to this bot.
 */

const { EmbedBuilder } = require('discord.js');

/**
 * The events this channel covers.
 *
 * `ban` is here and **has no producer today**: `ban` is a permission the
 * `admin` and `owner` roles grant in `admin-service.js` and that no command
 * consumes — there is no `/ban` in the gamemode or the panel. Keeping the type
 * declared is what makes the day that command exists cost one line, and the
 * test below locks the format so it isn't born different from the others.
 */
const EVENT_KINDS = Object.freeze({
  ban:                { title: 'Ban',                  color: 0x992d22, icon: '⛔' },
  kick:               { title: 'Kick',                 color: 0xe67e22, icon: '👢' },
  permakill:          { title: 'Permakill',            color: 0x71368a, icon: '⚰️' },
  whitelist_approve:  { title: 'Whitelist approved',   color: 0x2ecc71, icon: '✅' },
  whitelist_reject:   { title: 'Whitelist rejected',   color: 0xe74c3c, icon: '❌' },
  whitelist_reset:    { title: 'Whitelist reverted',   color: 0x95a5a6, icon: '↩️' },
  // OATHBOUND RP Design: an Advisor calls the Council from the High Hrothgar stone.
  council_summons:    { title: 'The Council is summoned', color: 0xc9a227, icon: '🔔' },
  council_answered:   { title: 'Summons answered',     color: 0x3498db, icon: '🌀' }
});

/** Trims and cleans text from outside before it becomes a Discord message. */
function sanitize(text, max = 512) {
  if (typeof text !== 'string') return null;
  return text
    // Defuse mass mentions: a kick reason with `@everyone` would ping the whole
    // guild, and whoever writes the reason is staff typing in game. The
    // separator is an ESCAPED zero-width space — the version with the raw
    // character made this file binary to `grep`, the same defect `core/soul.js`
    // had to fix: anyone reading the line would see `'@$1'` and conclude it
    // does nothing.
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    // Control characters become spaces. A line break injected into a reason
    // would break the embed apart.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max) || null;
}

/**
 * Validates the incoming event. Returns `{ ok: true, event }` or `{ ok: false, error }`.
 *
 * Kept separate from sending on purpose: it's the part that decides, and it has
 * to be exercisable without any Discord at all.
 */
function parseEvent(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing body' };

  const kind = raw.kind;
  if (!EVENT_KINDS[kind]) {
    return { ok: false, error: `unknown event kind: ${JSON.stringify(kind)}` };
  }

  const target = sanitize(raw.target, 128);
  if (!target) return { ok: false, error: 'target is required' };

  return {
    ok: true,
    event: {
      kind,
      target,
      // `moderator` is optional because not every event has a person behind it
      // — an automatic whitelist reversal, for example.
      moderator: sanitize(raw.moderator, 128),
      reason: sanitize(raw.reason),
      source: sanitize(raw.source, 32) || 'unknown',
      at: typeof raw.at === 'string' ? raw.at : new Date().toISOString()
    }
  };
}

/**
 * Builds the embed. Pure function — the test checks the content without touching Discord.
 */
function buildEmbed(event) {
  const meta = EVENT_KINDS[event.kind];

  const embed = new EmbedBuilder()
    .setTitle(`${meta.icon} ${meta.title}`)
    .setColor(meta.color)
    .setTimestamp(new Date(event.at))
    // Where it came from matters in a dispute: `gamemode` is an in-game
    // command, `panel` is someone logged into the web. Different responsibilities.
    .setFooter({ text: `source: ${event.source}` });

  const fields = [{ name: 'Target', value: event.target, inline: true }];
  if (event.moderator) fields.push({ name: 'Staff', value: event.moderator, inline: true });
  // The reason is the field that decides whether the log is good for anything.
  // Without it the line says something happened but not why, which is what
  // staff need when someone disputes it weeks later.
  fields.push({ name: 'Reason', value: event.reason || '_not provided_', inline: false });

  embed.addFields(fields);
  return embed;
}

/**
 * Delivers the event to the configured channel.
 *
 * **Never throws.** Returns `{ sent: boolean, error?: string }` — the caller is
 * an endpoint that has already responded, or a moderation action that has
 * already happened.
 *
 * @param {object} client   discord.js client
 * @param {object} event    output of `parseEvent`
 * @param {string} channelId
 */
async function sendModerationLog(client, event, channelId) {
  if (!channelId) {
    // Deliberate silence: an unconfigured channel means "this feature is off",
    // not an error. Shouting on every kick on a server that doesn't want the
    // log would be noise.
    return { sent: false, error: 'channel not configured' };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
      return { sent: false, error: `channel ${channelId} does not exist or does not accept messages` };
    }
    await channel.send({ embeds: [buildEmbed(event)] });
    return { sent: true };
  } catch (err) {
    console.error('[moderation-log] Failed to send event:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { EVENT_KINDS, parseEvent, buildEmbed, sendModerationLog, sanitize };
