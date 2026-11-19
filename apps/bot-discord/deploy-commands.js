/**
 * deploy-commands.js
 *
 * Registers the bot's slash commands in the configured guild.
 *
 * Runs automatically when the bot boots (`index.js`) — it used to be manual
 * only, and nothing warned when someone forgot: the command simply didn't show
 * up in Discord, with no error anywhere. It still works standalone:
 *
 *   npm run deploy-commands
 *
 * Guild commands (not global ones) propagate almost instantly — better for a
 * single-server bot like this one than global commands, which take up to 1h
 * to propagate.
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const voiceChannels = require('./voiceChannels');

/** Single source of the command list. New command modules go here. */
function collectCommands() {
  return [...voiceChannels.commands].map((c) => c.toJSON());
}

/**
 * Registers the commands in the guild.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnError] `true` for standalone use (we want a
 *   non-zero exit code); `false` at boot, where a registration failure must not
 *   bring the whole bot down — whitelist sync matters more than the voice
 *   commands, and keeps working without them.
 * @returns {Promise<{ok: boolean, count?: number, error?: string}>}
 */
async function deployCommands(opts = {}) {
  const { throwOnError = false } = opts;

  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  const missing = [];
  if (!token) missing.push('DISCORD_BOT_TOKEN');
  if (!clientId) missing.push('DISCORD_CLIENT_ID');
  if (!guildId) missing.push('GUILD_ID');

  if (missing.length > 0) {
    const error = `missing from .env: ${missing.join(', ')}`;
    if (throwOnError) throw new Error(error);
    return { ok: false, error };
  }

  const commands = collectCommands();
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    return { ok: true, count: commands.length };
  } catch (err) {
    if (throwOnError) throw err;
    return { ok: false, error: err.message };
  }
}

module.exports = { deployCommands, collectCommands };

// Direct execution (`node deploy-commands.js`).
if (require.main === module) {
  (async () => {
    try {
      const commands = collectCommands();
      console.log(`[deploy-commands] Registering ${commands.length} command(s) in guild ${process.env.GUILD_ID}...`);
      const result = await deployCommands({ throwOnError: true });
      console.log(`[deploy-commands] ${result.count} command(s) registered successfully.`);
    } catch (err) {
      console.error('[deploy-commands] Failed to register commands:', err.message);
      process.exit(1);
    }
  })();
}
