'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { parseEnv, isPlaceholder, auditProductionConfig } = require('./check-production-config');

const SECRET = 'a'.repeat(40);

function validConfigs() {
  return {
    web: {
      SESSION_SECRET: SECRET,
      INTERNAL_API_SECRET: SECRET,
      MASTER_KEY: 'b'.repeat(40),
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_CLIENT_SECRET: 'discord-secret-real',
      PANEL_PUBLIC_URL: 'https://rp.example.org',
      DISCORD_CALLBACK_URL: 'https://rp.example.org/api/auth/discord/callback',
      NODE_ENV: 'production',
      TRUST_PROXY: 'true'
    },
    gameApi: {
      INTERNAL_API_SECRET: SECRET,
      GAME_API_BIND_HOST: '0.0.0.0',
      MODS_MANIFEST_PATH: './mods.json'
    },
    bot: {
      INTERNAL_API_SECRET: SECRET,
      DISCORD_BOT_TOKEN: 'token-real',
      DISCORD_CLIENT_ID: '123456789012345678',
      GUILD_ID: '123456789012345678',
      WHITELIST_ROLE_ID: '123456789012345678'
    },
    launcher: {
      VITE_SERVER_IP: '203.0.113.10',
      VITE_DISCORD_CLIENT_ID: '123456789012345678',
      VITE_GITHUB_DIST_REPO: 'owner/distribution',
      VITE_PANEL_URL: 'https://rp.example.org'
    }
  };
}

describe('.env parser', () => {
  test('ignores comments and strips outer quotes', () => {
    assert.deepEqual(parseEnv('# x\nA=1\nB="two"\nC=\'three\''), { A: '1', B: 'two', C: 'three' });
  });

  test('recognizes placeholders without printing values', () => {
    assert.equal(isPlaceholder('YOUR_CLIENT_ID_HERE'), true);
    assert.equal(isPlaceholder('owner/repo'), false);
  });
});

describe('production audit', () => {
  test('approves a consistent configuration without a database', () => {
    assert.deepEqual(auditProductionConfig(validConfigs(), { skipDb: true }), []);
  });

  test('rejects public HTTP, a short secret and a development environment', () => {
    const configs = validConfigs();
    configs.web.PANEL_PUBLIC_URL = 'http://localhost:3001';
    configs.web.SESSION_SECRET = 'short';
    configs.web.NODE_ENV = 'development';
    const issues = auditProductionConfig(configs, { skipDb: true });
    assert.ok(issues.some(issue => issue.key === 'PANEL_PUBLIC_URL'));
    assert.ok(issues.some(issue => issue.key === 'SESSION_SECRET'));
    assert.ok(issues.some(issue => issue.key === 'NODE_ENV'));
  });

  test('rejects an internal secret that differs between services', () => {
    const configs = validConfigs();
    configs.bot.INTERNAL_API_SECRET = 'c'.repeat(40);
    assert.ok(auditProductionConfig(configs, { skipDb: true }).some(issue => issue.service === 'cross-service'));
  });

  test('database fields are only required without --skip-db', () => {
    assert.ok(auditProductionConfig(validConfigs()).some(issue => issue.key === 'DB_HOST'));
    assert.ok(!auditProductionConfig(validConfigs(), { skipDb: true }).some(issue => issue.key === 'DB_HOST'));
  });
});
