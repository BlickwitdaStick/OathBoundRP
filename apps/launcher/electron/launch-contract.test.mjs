import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(electronDir, 'main.ts'), 'utf8');
const start = main.indexOf("ipcMain.handle('launch-game'");
const handler = main.slice(start);

test('launch-game prepares and validates the connection before killing or starting processes', () => {
  assert.ok(start >= 0, 'launch-game handler not found');
  const prepareAt = handler.indexOf('prepareConnectionSettings({');
  const killAt = handler.indexOf('await killGameProcesses()');
  const spawnAt = handler.indexOf('await startGameProcess(');

  assert.ok(prepareAt >= 0, 'the fail-closed writer was not called');
  assert.ok(killAt > prepareAt, 'processes were killed before validating the configuration');
  assert.ok(spawnAt > killAt, 'the game was started before the previous shutdown finished');
});

test('launch-game returns a structured result and does not start SKSE through a shell', () => {
  assert.match(handler, /return \{ ok: true, pid: processResult\.pid \}/);
  assert.match(handler, /return \{ ok: false, code, error: message \}/);
  assert.doesNotMatch(handler, /exec\(`?['"]?\$?\{?exePath/);
});

test('bootstrap direto fica travado no contrato server-info-ignore', () => {
  const writer = fs.readFileSync(path.join(electronDir, 'connection-settings.mjs'), 'utf8');
  assert.match(writer, /clientSettings\['server-info-ignore'\]\s*=\s*true/);
  assert.match(writer, /writtenSettings\['server-info-ignore'\]\s*===\s*true/);
});

test("launch-game seeds the main menu's remote session without offline mode", () => {
  const call = handler.slice(handler.indexOf('prepareConnectionSettings({'));
  const callBody = call.slice(0, call.indexOf('});'));
  assert.match(callBody, /displayName:/, "the authorization widget needs the player's name");
  // profileId in gameData turns on the AuthService offline mode (connects
  // without the authentication screen and without checking the session on the master).
  assert.doesNotMatch(callBody, /profileId/);
  const writer = fs.readFileSync(path.join(electronDir, 'connection-settings.mjs'), 'utf8');
  assert.match(writer, /auth-data-no-load\.js/);
  assert.doesNotMatch(writer, /gameData\.profileId\s*=/);
});

test("PLAY installs/enables the server's mods BEFORE the parity check", () => {
  const home = fs.readFileSync(path.join(electronDir, '..', 'src', 'pages', 'Home.tsx'), 'utf8');
  const play = home.slice(home.indexOf('const handlePlay = async'));
  const checkAt = play.indexOf('checkServerMods(gamePath)');
  const askAt = play.indexOf('askToInstallServerMods(');
  const installAt = play.indexOf('installServerMods(gamePath');
  const verifyAt = play.indexOf('verifyMods(gamePath)');
  const queueAt = play.indexOf('joinQueue()');
  assert.ok(checkAt > 0 && askAt > checkAt && installAt > askAt, 'checks, asks, only then downloads');
  assert.ok(verifyAt > installAt, 'parity after the install — otherwise it fails whoever just downloaded');
  assert.ok(queueAt > verifyAt, 'queue only after everything is validated');
});
