import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConnectionSettingsError,
  prepareConnectionSettings
} from './connection-settings.mjs';

function fixture() {
  const gamePath = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-rp-connection-'));
  const directory = path.join(gamePath, 'Data', 'Platform', 'Plugins');
  fs.mkdirSync(directory, { recursive: true });
  return {
    gamePath,
    directory,
    configPath: path.join(directory, 'skymp_config.json'),
    settingsPath: path.join(directory, 'skymp5-client-settings.txt')
  };
}

function cleanup(gamePath) {
  fs.rmSync(gamePath, { recursive: true, force: true });
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof ConnectionSettingsError && error.code === code);
}

test('writes both contracts, keeps compatible legacy data and removes untrusted credentials', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.configPath, JSON.stringify({ ui: { scale: 2 }, profileId: 99, token: 'old' }));
    fs.writeFileSync(f.settingsPath, JSON.stringify({
      language: 'en-US',
      launcherTicket: 'old',
      gameData: { difficulty: 'hard', profileId: 5, token: 'old', launcherTicket: 'old' }
    }));

    const result = prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: 'opaque-ticket',
      serverIp: 'game.example.com',
      serverPort: '7777',
      discordId: '12345'
    });

    assert.equal(result.config.session, 'ticket:opaque-ticket');
    assert.equal(result.config.serverAddress, 'game.example.com:7777');
    assert.equal(result.config.discordId, '12345');
    assert.deepEqual(result.config.ui, { scale: 2 });
    assert.equal(Object.hasOwn(result.config, 'profileId'), false);
    assert.equal(Object.hasOwn(result.config, 'token'), false);

    assert.equal(result.clientSettings.language, 'en-US');
    assert.equal(result.clientSettings['server-info-ignore'], true);
    assert.equal(result.clientSettings['server-ip'], 'game.example.com');
    assert.equal(result.clientSettings['server-port'], 7777);
    assert.equal(result.clientSettings.master, '');
    assert.deepEqual(result.clientSettings.gameData, { difficulty: 'hard', session: 'opaque-ticket' });
    assert.equal(Object.hasOwn(result.clientSettings, 'launcherTicket'), false);
    assert.match(fs.readFileSync(f.configPath, 'utf8'), /\n$/);
  } finally { cleanup(f.gamePath); }
});

test('rejects an empty ticket before creating files', () => {
  const f = fixture();
  try {
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: '   ',
      serverIp: '127.0.0.1',
      serverPort: 7777
    }), 'EMPTY_TICKET');
    assert.equal(fs.existsSync(f.configPath), false);
    assert.equal(fs.existsSync(f.settingsPath), false);
  } finally { cleanup(f.gamePath); }
});

test('invalid JSON fails closed without changing the other file', () => {
  const f = fixture();
  try {
    const original = JSON.stringify({ preserve: true });
    fs.writeFileSync(f.configPath, original);
    fs.writeFileSync(f.settingsPath, '{truncated');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: 'ticket',
      serverIp: '127.0.0.1',
      serverPort: 7777
    }), 'INVALID_EXISTING_JSON');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), '{truncated');
  } finally { cleanup(f.gamePath); }
});

test('accepts legacy settings without gameData and keeps unknown fields', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.settingsPath, JSON.stringify({ legacyOption: 42 }));
    const result = prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: 'ticket',
      serverIp: '2001:db8::1',
      serverPort: 7777
    });
    assert.equal(result.config.serverAddress, '[2001:db8::1]:7777');
    assert.equal(result.clientSettings.legacyOption, 42);
    assert.deepEqual(result.clientSettings.gameData, { session: 'ticket' });
  } finally { cleanup(f.gamePath); }
});

test('updates a read-only file and restores its mode', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.configPath, '{}');
    fs.writeFileSync(f.settingsPath, '{}');
    fs.chmodSync(f.configPath, 0o444);
    fs.chmodSync(f.settingsPath, 0o444);

    prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: 'ticket',
      serverIp: 'localhost',
      serverPort: 7777
    });

    assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o444);
    assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o444);
    assert.equal(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')).gameData.session, 'ticket');
  } finally {
    try { fs.chmodSync(f.configPath, 0o600); } catch {}
    try { fs.chmodSync(f.settingsPath, 0o600); } catch {}
    cleanup(f.gamePath);
  }
});

test('validates host and port with clear codes', () => {
  const f = fixture();
  try {
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'https://bad.example', serverPort: 7777
    }), 'INVALID_SERVER_HOST');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'game.example', serverPort: 70000
    }), 'INVALID_SERVER_PORT');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'game.example', serverPort: '7x77'
    }), 'INVALID_SERVER_PORT');
  } finally { cleanup(f.gamePath); }
});

test('rejects a JSON root that is not an object', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.configPath, '[]');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'localhost', serverPort: 7777
    }), 'INVALID_EXISTING_SHAPE');
  } finally { cleanup(f.gamePath); }
});

// ── AuthService remote session (main menu) ──────────────────────────────────
//
// The distributed skymp5-client does NOT read `gameData.session` from the
// settings: the only source of a remote session is
// `Data/Platform/PluginsNoLoad/auth-data-no-load.js`, read by
// `AuthService.readAuthDataFromDisk()` as
// `JSON.parse(getPluginSourceCode(...).slice(2))`. This helper reproduces that
// read literally to prove the written file is accepted by the client.
function readLikeSkympClient(authDataPath) {
  const data = fs.readFileSync(authDataPath, 'utf8');
  if (!data) return null;
  return JSON.parse(data.slice(2)) || null;
}

function authDataPathOf(gamePath) {
  return path.join(gamePath, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js');
}

test('seeds the remote session the AuthService reads on the main menu, replacing //null', () => {
  const f = fixture();
  try {
    const authDataPath = authDataPathOf(f.gamePath);
    fs.mkdirSync(path.dirname(authDataPath), { recursive: true });
    fs.writeFileSync(authDataPath, '//null');

    const result = prepareConnectionSettings({
      gamePath: f.gamePath,
      ticket: 'opaque-ticket',
      serverIp: '127.0.0.1',
      serverPort: 7777,
      discordId: '12345',
      displayName: '  Ysolda  '
    });

    assert.equal(result.authDataPath, authDataPath);
    const raw = fs.readFileSync(authDataPath, 'utf8');
    assert.ok(raw.startsWith('//{'), "same format as the client's writeAuthDataToDisk");
    assert.notEqual(raw.charCodeAt(0), 0xfeff, 'no BOM: slice(2) would break the JSON');

    const authData = readLikeSkympClient(authDataPath);
    assert.equal(authData.session, 'opaque-ticket', 'raw session, same as gameData.session on the server');
    assert.equal(authData.discordUsername, 'Ysolda');
    for (const forbidden of ['profileId', 'token', 'launcherTicket']) {
      assert.equal(Object.hasOwn(authData, forbidden), false, `${forbidden} never goes to the client`);
    }
    // No temporary files left behind in the folder SkyrimPlatform scans.
    assert.deepEqual(fs.readdirSync(path.dirname(authDataPath)), ['auth-data-no-load.js']);
  } finally { cleanup(f.gamePath); }
});

test('creates PluginsNoLoad when missing and uses the default label with no display name', () => {
  const f = fixture();
  try {
    prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'localhost', serverPort: 7777
    });
    const authData = readLikeSkympClient(authDataPathOf(f.gamePath));
    assert.equal(authData.session, 'ticket');
    assert.equal(typeof authData.discordUsername, 'string');
    assert.ok(authData.discordUsername.length > 0, 'o widget nunca mostra "id: undefined"');
  } finally { cleanup(f.gamePath); }
});

test('an empty ticket does not touch the previous remote session', () => {
  const f = fixture();
  try {
    const authDataPath = authDataPathOf(f.gamePath);
    fs.mkdirSync(path.dirname(authDataPath), { recursive: true });
    fs.writeFileSync(authDataPath, '//null');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: '', serverIp: '127.0.0.1', serverPort: 7777
    }), 'EMPTY_TICKET');
    assert.equal(fs.readFileSync(authDataPath, 'utf8'), '//null');
  } finally { cleanup(f.gamePath); }
});

test('no temporary file is left behind in Plugins (single-dot prefix)', () => {
  const f = fixture();
  try {
    prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'localhost', serverPort: 7777
    });
    assert.deepEqual(
      fs.readdirSync(f.directory).sort(),
      ['skymp5-client-settings.txt', 'skymp_config.json']
    );
  } finally { cleanup(f.gamePath); }
});
