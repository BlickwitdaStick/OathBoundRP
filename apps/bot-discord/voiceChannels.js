/**
 * voiceChannels.js
 *
 * Temporary voice channels — a practical voice alternative while the
 * gamemode's native VOIP (the in-game voice command) depends on a client patch
 * that doesn't exist upstream yet (see docs/technical/VOICE_CLIENT_PATCH.md).
 *
 * Flow:
 *   - Staff runs /voice-create <name> → creates a temporary voice channel under
 *     VOICE_CATEGORY_ID, marked as "managed" in memory.
 *   - When the channel goes empty, it is deleted automatically after a grace
 *     period (avoids flicker if someone reconnects quickly).
 *   - /voice-close deletes the current channel immediately (staff, or the creator).

 *
 * Nothing is persisted to the database — if the bot restarts, temporary
 * channels already created stop being "managed" (they won't be auto-deleted),
 * but keep existing until someone deletes them by hand. Acceptable for the
 * scope: it's a staff convenience tool, not a critical RP system.
 */

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');

const EMPTY_CHANNEL_GRACE_MS = 30 * 1000;

const CREATE_COMMAND = 'voice-create';
const CLOSE_COMMAND = 'voice-close';

// channelId -> { createdBy, emptyTimer }
const _managedChannels = new Map();

function isStaffMember(member, staffRoleId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (staffRoleId && member.roles.cache.has(staffRoleId)) return true;
  return false;
}

function sanitizeChannelName(raw) {
  const cleaned = String(raw || '').trim().slice(0, 60);
  return cleaned || 'rp-room';
}

/**
 * Cancels a channel's auto-removal timer (if any) — called when someone joins
 * a channel that was in its grace window before being deleted.
 */
function cancelPendingRemoval(channelId) {
  const entry = _managedChannels.get(channelId);
  if (entry && entry.emptyTimer) {
    clearTimeout(entry.emptyTimer);
    entry.emptyTimer = null;
  }
}

/**
 * Schedules removal of an empty managed channel after the grace period.
 * If someone joins before the timer fires, cancelPendingRemoval handles it
 * via the voiceStateUpdate listener in index.js.
 */
function scheduleRemovalIfEmpty(channel) {
  const entry = _managedChannels.get(channel.id);
  if (!entry) return; // not a channel we manage
  if (channel.members.size > 0) return;

  cancelPendingRemoval(channel.id);
  entry.emptyTimer = setTimeout(async () => {
    try {
      if (channel.members.size === 0) {
        await channel.delete('Empty temporary voice channel (RP)');
        _managedChannels.delete(channel.id);
        console.log(`[voice-channels] Temporary channel ${channel.id} removed (empty).`);
      }
    } catch (err) {
      console.error('[voice-channels] Failed to remove empty channel:', err.message);
    }
  }, EMPTY_CHANNEL_GRACE_MS);
  if (typeof entry.emptyTimer.unref === 'function') entry.emptyTimer.unref();
}

const commands = [
  new SlashCommandBuilder()
    .setName(CREATE_COMMAND)
    .setDescription('[Staff] Create a temporary voice channel for an RP scene')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Name of the scene/location').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName(CLOSE_COMMAND)
    .setDescription('[Staff] Close the current temporary voice channel')
];

async function handleInteraction(interaction, { staffRoleId, voiceCategoryId }) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== CREATE_COMMAND && interaction.commandName !== CLOSE_COMMAND) return false;

  if (!isStaffMember(interaction.member, staffRoleId)) {
    await interaction.reply({ content: 'Only staff can manage temporary voice channels.', ephemeral: true });
    return true;
  }

  if (interaction.commandName === CREATE_COMMAND) {
    const rawName = interaction.options.getString('name');
    const channelName = `🎙️ ${sanitizeChannelName(rawName)}`;

    if (!voiceCategoryId) {
      await interaction.reply({ content: 'VOICE_CATEGORY_ID is not set in the bot\'s .env.', ephemeral: true });
      return true;
    }

    try {
      const channel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: voiceCategoryId
      });
      _managedChannels.set(channel.id, { createdBy: interaction.user.id, emptyTimer: null });
      scheduleRemovalIfEmpty(channel); // starts empty — schedule removal in case nobody joins
      await interaction.reply({ content: `Channel created: ${channel}`, ephemeral: false });
    } catch (err) {
      console.error('[voice-channels] Failed to create channel:', err.message);
      await interaction.reply({ content: 'Could not create the channel.', ephemeral: true });
    }
    return true;
  }

  // /voice-close
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || !_managedChannels.has(voiceChannel.id)) {
    await interaction.reply({ content: 'You need to be in a managed temporary voice channel to close it.', ephemeral: true });
    return true;
  }

  try {
    cancelPendingRemoval(voiceChannel.id);
    await voiceChannel.delete(`Closed manually via /${CLOSE_COMMAND}`);
    _managedChannels.delete(voiceChannel.id);
    await interaction.reply({ content: 'Channel closed.', ephemeral: true });
  } catch (err) {
    console.error('[voice-channels] Failed to close channel:', err.message);
    await interaction.reply({ content: 'Could not close the channel.', ephemeral: true });
  }
  return true;
}

/**
 * Called by the voiceStateUpdate listener in index.js whenever someone
 * joins/leaves a voice channel — maintains the managed channels' lifecycle
 * (cancels removal if someone joins, schedules it if the channel goes empty).
 */
function handleVoiceStateUpdate(oldState, newState) {
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  if (newChannel && _managedChannels.has(newChannel.id)) {
    cancelPendingRemoval(newChannel.id);
  }
  if (oldChannel && oldChannel.id !== newChannel?.id && _managedChannels.has(oldChannel.id)) {
    scheduleRemovalIfEmpty(oldChannel);
  }
}

module.exports = {
  commands,
  handleInteraction,
  handleVoiceStateUpdate,
  isStaffMember,
  sanitizeChannelName,
  // Exposed for tests only
  _managedChannels,
  _scheduleRemovalIfEmpty: scheduleRemovalIfEmpty,
  _cancelPendingRemoval: cancelPendingRemoval
};
