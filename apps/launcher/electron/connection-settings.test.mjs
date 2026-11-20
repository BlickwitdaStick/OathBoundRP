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

test('grava os dois contratos, preserva legado compatível e remove credenciais não confiáveis', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.configPath, JSON.stringify({ ui: { scale: 2 }, profileId: 99, token: 'old' }));
    fs.writeFileSync(f.settingsPath, JSON.stringify({
      language: 'pt-BR',
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

    assert.equal(result.clientSettings.language, 'pt-BR');
    assert.equal(result.clientSettings['server-info-ignore'], true);
    assert.equal(result.clientSettings['server-ip'], 'game.example.com');
    assert.equal(result.clientSettings['server-port'], 7777);
    assert.equal(result.clientSettings.master, '');
    assert.deepEqual(result.clientSettings.gameData, { difficulty: 'hard', session: 'opaque-ticket' });
    assert.equal(Object.hasOwn(result.clientSettings, 'launcherTicket'), false);
    assert.match(fs.readFileSync(f.configPath, 'utf8'), /\n$/);
  } finally { cleanup(f.gamePath); }
});

test('recusa ticket vazio antes de criar arquivos', () => {
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

test('JSON inválido falha fechado sem alterar o outro arquivo', () => {
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

test('aceita settings legado sem gameData e preserva campos desconhecidos', () => {
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

test('atualiza arquivo read-only e restaura seu modo', () => {
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

test('valida host e porta com códigos claros', () => {
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

test('recusa raiz JSON que não seja objeto', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.configPath, '[]');
    expectCode(() => prepareConnectionSettings({
      gamePath: f.gamePath, ticket: 'ticket', serverIp: 'localhost', serverPort: 7777
    }), 'INVALID_EXISTING_SHAPE');
  } finally { cleanup(f.gamePath); }
});

// ── Sessão remota do AuthService (menu principal) ───────────────────────────
//
// O skymp5-client distribuído NÃO lê `gameData.session` do settings: a única
// fonte de sessão remota é `Data/Platform/PluginsNoLoad/auth-data-no-load.js`,
// lido por `AuthService.readAuthDataFromDisk()` como
// `JSON.parse(getPluginSourceCode(...).slice(2))`. Este helper reproduz essa
// leitura literalmente para provar que o arquivo gravado é aceito pelo cliente.
function readLikeSkympClient(authDataPath) {
  const data = fs.readFileSync(authDataPath, 'utf8');
  if (!data) return null;
  return JSON.parse(data.slice(2)) || null;
}

function authDataPathOf(gamePath) {
  return path.join(gamePath, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js');
}

test('semeia a sessão remota que o AuthService lê no menu principal, substituindo //null', () => {
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
    assert.ok(raw.startsWith('//{'), 'formato idêntico ao writeAuthDataToDisk do cliente');
    assert.notEqual(raw.charCodeAt(0), 0xfeff, 'sem BOM: slice(2) quebraria o JSON');

    const authData = readLikeSkympClient(authDataPath);
    assert.equal(authData.session, 'opaque-ticket', 'sessão crua, igual a gameData.session no servidor');
    assert.equal(authData.discordUsername, 'Ysolda');
    for (const forbidden of ['profileId', 'token', 'launcherTicket']) {
      assert.equal(Object.hasOwn(authData, forbidden), false, `${forbidden} nunca vai para o cliente`);
    }
    // Nada de temporários esquecidos na pasta que o SkyrimPlatform varre.
    assert.deepEqual(fs.readdirSync(path.dirname(authDataPath)), ['auth-data-no-load.js']);
  } finally { cleanup(f.gamePath); }
});

test('cria PluginsNoLoad quando ausente e usa rótulo padrão sem nome de exibição', () => {
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

test('ticket vazio não toca a sessão remota anterior', () => {
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

test('nenhum temporário fica para trás em Plugins (prefixo de um único ponto)', () => {
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
