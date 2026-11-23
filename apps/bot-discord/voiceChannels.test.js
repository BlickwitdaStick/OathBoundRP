/**
 * voiceChannels.test.js
 *
 * Tests for the parts of voiceChannels.js that don't need a real Discord
 * connection: the staff permission check, channel name sanitization, and the
 * schedule/cancel lifecycle of empty-channel removal. Real interaction with
 * the Discord API (creating/deleting a channel, replying to an interaction)
 * is not covered here — validating it needs a real bot/guild.
 *
 * Run with: node --test voiceChannels.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

const voiceChannels = require('./voiceChannels');

describe('isStaffMember', () => {
  it('allows a member with the configured staff role', () => {
    const member = { permissions: { has: () => false }, roles: { cache: new Map([['staff-role', true]]) } };
    assert.strictEqual(voiceChannels.isStaffMember(member, 'staff-role'), true);
  });

  it('allows an administrator even without the staff role', () => {
    const member = { permissions: { has: () => true }, roles: { cache: new Map() } };
    assert.strictEqual(voiceChannels.isStaffMember(member, 'staff-role'), true);
  });

  it('blocks a member who is neither admin nor has the role', () => {
    const member = { permissions: { has: () => false }, roles: { cache: new Map() } };
    assert.strictEqual(voiceChannels.isStaffMember(member, 'staff-role'), false);
  });

  it('blocks a null member', () => {
    assert.strictEqual(voiceChannels.isStaffMember(null, 'staff-role'), false);
  });
});

describe('sanitizeChannelName', () => {
  it('keeps a valid name', () => {
    assert.strictEqual(voiceChannels.sanitizeChannelName('The Bannered Mare Tavern'), 'The Bannered Mare Tavern');
  });

  it('truncates very long names to 60 characters', () => {
    const long = 'x'.repeat(100);
    assert.strictEqual(voiceChannels.sanitizeChannelName(long).length, 60);
  });

  it('uses a fallback for empty input', () => {
    assert.strictEqual(voiceChannels.sanitizeChannelName(''), 'rp-room');
    assert.strictEqual(voiceChannels.sanitizeChannelName('   '), 'rp-room');
    assert.strictEqual(voiceChannels.sanitizeChannelName(null), 'rp-room');
  });
});

describe('managed channel lifecycle', () => {
  function fakeChannel(id, memberCount) {
    return { id, members: { size: memberCount }, delete: async () => {} };
  }

  beforeEach(() => {
    voiceChannels._managedChannels.clear();
  });

  afterEach(() => {
    for (const entry of voiceChannels._managedChannels.values()) {
      if (entry.emptyTimer) clearTimeout(entry.emptyTimer);
    }
    voiceChannels._managedChannels.clear();
  });

  it('schedules removal only for channels we manage', () => {
    const untracked = fakeChannel('untracked-channel', 0);
    voiceChannels._scheduleRemovalIfEmpty(untracked);
    assert.strictEqual(voiceChannels._managedChannels.has('untracked-channel'), false);
  });

  it('does not schedule removal while the channel still has people', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 2);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('schedules removal when the managed channel goes empty', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer, 'should have scheduled a timer');
  });

  it('cancelPendingRemoval clears the scheduled timer', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer);

    voiceChannels._cancelPendingRemoval('c1');
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('handleVoiceStateUpdate cancels removal when someone joins the channel', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer);

    // Someone joins c1: oldState with no channel, newState with channel c1.
    voiceChannels.handleVoiceStateUpdate({ channel: null }, { channel: fakeChannel('c1', 1) });
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('handleVoiceStateUpdate schedules removal when someone leaves the channel empty', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });

    // Someone leaves c1 (now empty): oldState with channel c1, newState with no channel.
    voiceChannels.handleVoiceStateUpdate({ channel: fakeChannel('c1', 0) }, { channel: null });
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer, 'should have scheduled removal on going empty');
  });
});
