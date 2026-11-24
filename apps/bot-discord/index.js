require('dotenv').config();
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const app = express();
const voiceChannels = require('./voiceChannels');
const moderationLog = require('./moderationLog');
const memberAccess = require('./memberAccess');
const { deployCommands } = require('./deploy-commands');
const { createMemoryRateLimiter } = require('./rateLimiter');
const { isDiscordSnowflake } = require('./inputValidation');
const { createRuntimeMetrics } = require('../shared/runtimeMetrics');

const runtimeMetrics = createRuntimeMetrics({ service: 'bot-discord' });
app.disable('x-powered-by');
app.use(runtimeMetrics.middleware);
app.use(express.json({ limit: '64kb' }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates]
});

const GUILD_ID = process.env.GUILD_ID;
const WHITELIST_ROLE_ID = process.env.WHITELIST_ROLE_ID;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const VOICE_CATEGORY_ID = process.env.VOICE_CATEGORY_ID;
// Moderation log channel. Without it the endpoint still responds 202 and sends
// nothing: whoever configures the server decides whether they want the channel,
// and a server without one must not see `/permakill` fail because of it.
const MODERATION_LOG_CHANNEL_ID = process.env.MODERATION_LOG_CHANNEL_ID;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} must be set`);
    }
    return value;
}

requireEnv('DISCORD_BOT_TOKEN');
requireEnv('GUILD_ID');
requireEnv('WHITELIST_ROLE_ID');
requireEnv('INTERNAL_API_SECRET');

client.once('ready', async () => {
    console.log(`[discord-bot] Bot logged in as ${client.user.tag}`);

    // Registers the slash commands at boot. This used to be a manual step
    // (`npm run deploy-commands`) and nothing warned when someone forgot — the
    // command simply didn't show up in Discord, with no error at all.
    //
    // A failure here does NOT bring the bot down: whitelist sync is the
    // critical feature and keeps working without the voice commands.
    const result = await deployCommands();
    if (result.ok) {
        console.log(`[discord-bot] ${result.count} slash command(s) registered in the guild.`);
    } else {
        console.error(`[discord-bot] COULD NOT register the slash commands: ${result.error}`);
        console.error('[discord-bot] /voice-create and /voice-close will not show up in Discord until this is fixed.');
    }
});

// Temporary voice channels (/voice-create, /voice-close) — see voiceChannels.js.
// Commands are registered at boot (see above) or with `node deploy-commands.js`.
client.on('interactionCreate', async (interaction) => {
    try {
        await voiceChannels.handleInteraction(interaction, {
            staffRoleId: STAFF_ROLE_ID,
            voiceCategoryId: VOICE_CATEGORY_ID
        });
    } catch (err) {
        console.error('[discord-bot] Error handling interaction:', err.message);
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    voiceChannels.handleVoiceStateUpdate(oldState, newState);
});

// ── In-memory rate limiting, with a global and per-bucket cap ───────────────
const { isRateLimited } = createMemoryRateLimiter();

// Constant-time comparison to avoid timing attacks on the internal secret
function isValidInternalSecret(provided) {
    if (typeof provided !== 'string' || !provided) return false;
    const expected = Buffer.from(INTERNAL_API_SECRET);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}

// Endpoint that receives the webhook from the Web Panel
app.post('/api/sync-role', async (req, res) => {
    const { discord_id, status } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (isRateLimited(`sync-role:${ip}`, 20, 60 * 1000)) {
        runtimeMetrics.recordRejection('rate_limit_sync_role');
        return res.status(429).json({ error: 'Too many requests' });
    }

    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        runtimeMetrics.recordRejection('internal_secret_invalid');
        console.warn(`[discord-bot] Unauthorized access attempt to /api/sync-role from ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!isDiscordSnowflake(discord_id)) {
        return res.status(400).json({ error: 'Invalid discord_id' });
    }
    if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (!GUILD_ID || !WHITELIST_ROLE_ID) return res.status(500).json({ error: 'GUILD_ID or WHITELIST_ROLE_ID not configured' });
    
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discord_id).catch(() => null);
        
        if (!member) {
            console.log(`[discord-bot] Member ${discord_id} not found in the guild.`);
            return res.status(404).json({ error: 'Member not found in guild' });
        }
        
        if (status === 'approved') {
            await member.roles.add(WHITELIST_ROLE_ID);
            console.log(`[discord-bot] Role added for ${discord_id}`);
        } else if (status === 'rejected' || status === 'pending') {
            await member.roles.remove(WHITELIST_ROLE_ID);
            console.log(`[discord-bot] Role removed for ${discord_id}`);
        }
        
        res.json({ ok: true });
    } catch (err) {
        console.error(`[discord-bot] Sync error:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * What a member's Discord roles grant in game: the whitelist and a staff role
 * (`memberAccess.js`). The panel asks when a player signs in or presses Play,
 * so a role given on Discord counts at their next Play — no SQL by hand.
 * POST so the Discord id stays out of URLs and access logs.
 */
const STAFF_ROLE_MAP = memberAccess.staffRoleMapFromEnv();
for (const err of STAFF_ROLE_MAP.errors) console.warn(`[discord-bot] STAFF_ROLE_MAP: ${err}`);
const WHITELIST_ROLE_IDS = memberAccess.whitelistRoleIdsFromEnv();
for (const err of WHITELIST_ROLE_IDS.errors) console.warn(`[discord-bot] WHITELIST_ROLE_IDS: ${err}`);

app.post('/api/member-access', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`member-access:${ip}`, 120, 60 * 1000)) {
        runtimeMetrics.recordRejection('rate_limit_member_access');
        return res.status(429).json({ error: 'Too many requests' });
    }
    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        runtimeMetrics.recordRejection('internal_secret_invalid');
        console.warn(`[discord-bot] Unauthorized access attempt to /api/member-access from ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const discordId = (req.body || {}).discord_id;
    if (!isDiscordSnowflake(discordId)) return res.status(400).json({ error: 'Invalid discord_id' });
    if (!GUILD_ID) return res.status(500).json({ error: 'GUILD_ID not configured' });

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) return res.json({ inGuild: false, whitelisted: false, staffRole: null });
        const access = memberAccess.accessFor(member.roles.cache.keys(), {
            whitelistRoleIds: WHITELIST_ROLE_IDS.ids,
            staffRoleMap: STAFF_ROLE_MAP.map
        });
        res.json({ inGuild: true, ...access });
    } catch (err) {
        console.error('[discord-bot] member-access error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Moderation log — see `moderationLog.js` and `docs/ARCHITECTURE.md` 1.3.
 *
 * Responds **202 and does not wait for Discord**. The moderation action has
 * already happened when this request arrives: the gamemode already kicked, the
 * panel already stored the whitelist decision. Holding the response until
 * Discord confirms would make a `/permakill` wait on a third-party API, and
 * would turn Discord's slowness into slowness of the staff command.
 *
 * An invalid body responds 400 — the sender has a bug and needs to know.
 */
app.post('/api/moderation-log', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (isRateLimited(`moderation-log:${ip}`, 60, 60 * 1000)) {
        runtimeMetrics.recordRejection('rate_limit_moderation_log');
        return res.status(429).json({ error: 'Too many requests' });
    }

    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        runtimeMetrics.recordRejection('internal_secret_invalid');
        console.warn(`[discord-bot] Unauthorized attempt on /api/moderation-log from ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = moderationLog.parseEvent(req.body);
    if (!parsed.ok) {
        console.warn(`[discord-bot] Moderation event rejected: ${parsed.error}`);
        return res.status(400).json({ error: parsed.error });
    }

    res.status(202).json({ ok: true });

    // After the response, on purpose. A failure here becomes a log line and
    // nothing more — the real record is `audit_logs`, which is already written.
    moderationLog.sendModerationLog(client, parsed.event, MODERATION_LOG_CHANNEL_ID)
        .then(r => {
            if (!r.sent && r.error !== 'channel not configured') {
                console.error(`[discord-bot] Event '${parsed.event.kind}' did not reach the channel: ${r.error}`);
            }
        });
});

app.get('/api/metrics', (req, res) => {
    if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
        runtimeMetrics.recordRejection('internal_secret_invalid');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.json(runtimeMetrics.snapshot());
});

app.get('/health', (req, res) => {
    const ready = client.isReady();
    return res.status(ready ? 200 : 503).json({ ok: ready, discord: ready ? 'ready' : 'not_ready' });
});

const PORT = process.env.PORT || 3002;
// Safe default on the host. In a container, use 0.0.0.0 only inside the
// compose private network and don't publish the port on the host.
const HOST = process.env.BOT_API_BIND_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`[discord-bot] Internal API running at http://${HOST}:${PORT}`);
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
    console.error("[discord-bot] Failed to log in to Discord. Check DISCORD_BOT_TOKEN in the .env file");
});
