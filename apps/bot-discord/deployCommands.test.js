/**
 * Tests for slash command registration.
 *
 * They don't touch the Discord API: they cover environment validation and the
 * return contract, which is what decides whether a failure brings the bot down
 * or just gets logged.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { deployCommands, collectCommands } = require('./deploy-commands');

const ENV_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'GUILD_ID'];
let saved;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('collectCommands', () => {
  test('returns the voice commands in serialized form', () => {
    const commands = collectCommands();
    assert.ok(commands.length >= 2);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes('voice-create'));
    assert.ok(names.includes('voice-close'));
  });

  test('every command has a name and a description', () => {
    for (const c of collectCommands()) {
      assert.ok(c.name, 'command without a name');
      assert.ok(c.description, `command ${c.name} has no description`);
    }
  });
});

describe('deployCommands — incomplete environment', () => {
  // At boot, missing configuration must not bring the bot down: whitelist
  // sync is the critical feature and works without the voice commands.
  test('without env, returns an error instead of throwing', async () => {
    const result = await deployCommands();
    assert.equal(result.ok, false);
    assert.match(result.error, /DISCORD_BOT_TOKEN/);
  });

  test('lists ALL missing variables, not just the first', async () => {
    const result = await deployCommands();
    assert.match(result.error, /DISCORD_BOT_TOKEN/);
    assert.match(result.error, /DISCORD_CLIENT_ID/);
    assert.match(result.error, /GUILD_ID/);
  });

  test('points out only what is missing when the rest is present', async () => {
    process.env.DISCORD_BOT_TOKEN = 'x';
    process.env.DISCORD_CLIENT_ID = 'y';
    const result = await deployCommands();
    assert.equal(result.ok, false);
    assert.match(result.error, /GUILD_ID/);
    assert.ok(!result.error.includes('DISCORD_BOT_TOKEN'), 'should not flag what is configured');
  });

  // Standalone, we want exit code != 0, so there it does need to throw.
  test('throwOnError makes it throw', async () => {
    await assert.rejects(() => deployCommands({ throwOnError: true }), /missing from \.env/);
  });
});
