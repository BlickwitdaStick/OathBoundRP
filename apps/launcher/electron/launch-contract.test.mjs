import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(electronDir, 'main.ts'), 'utf8');
const start = main.indexOf("ipcMain.handle('launch-game'");
const handler = main.slice(start);

test('launch-game prepara e valida a conexão antes de matar ou iniciar processos', () => {
  assert.ok(start >= 0, 'handler launch-game nao encontrado');
  const prepareAt = handler.indexOf('prepararConfiguracaoConexao({');
  const killAt = handler.indexOf('await killGameProcesses()');
  const spawnAt = handler.indexOf('await iniciarProcessoJogo(');

  assert.ok(prepareAt >= 0, 'writer fail-closed nao foi chamado');
  assert.ok(killAt > prepareAt, 'processos foram encerrados antes de validar a configuracao');
  assert.ok(spawnAt > killAt, 'jogo foi iniciado antes do encerramento anterior terminar');
});

test('launch-game devolve resultado estruturado e nao inicia o SKSE por shell', () => {
  assert.match(handler, /return \{ ok: true, pid: processResult\.pid \}/);
  assert.match(handler, /return \{ ok: false, code, error: message \}/);
  assert.doesNotMatch(handler, /exec\(`?['"]?\$?\{?exePath/);
});

test('bootstrap direto fica travado no contrato server-info-ignore', () => {
  const writer = fs.readFileSync(path.join(electronDir, 'connection-settings.mjs'), 'utf8');
  assert.match(writer, /clientSettings\['server-info-ignore'\]\s*=\s*true/);
  assert.match(writer, /writtenSettings\['server-info-ignore'\]\s*===\s*true/);
});

test('launch-game semeia a sessão remota do menu principal sem modo offline', () => {
  const call = handler.slice(handler.indexOf('prepararConfiguracaoConexao({'));
  const callBody = call.slice(0, call.indexOf('});'));
  assert.match(callBody, /displayName:/, 'o widget de autorizacao precisa do nome do jogador');
  // profileId em gameData liga o modo offline do AuthService (conecta sem a
  // tela de autenticacao e sem verificar a sessao no master).
  assert.doesNotMatch(callBody, /profileId/);
  const writer = fs.readFileSync(path.join(electronDir, 'connection-settings.mjs'), 'utf8');
  assert.match(writer, /auth-data-no-load\.js/);
  assert.doesNotMatch(writer, /gameData\.profileId\s*=/);
});

test('PLAY instala/habilita os mods do servidor ANTES da verificacao de paridade', () => {
  const home = fs.readFileSync(path.join(electronDir, '..', 'src', 'pages', 'Home.tsx'), 'utf8');
  const play = home.slice(home.indexOf('const handlePlay = async'));
  const checkAt = play.indexOf('checkServerMods(gamePath)');
  const askAt = play.indexOf('askToInstallServerMods(');
  const installAt = play.indexOf('installServerMods(gamePath');
  const verifyAt = play.indexOf('verifyMods(gamePath)');
  const queueAt = play.indexOf('joinQueue()');
  assert.ok(checkAt > 0 && askAt > checkAt && installAt > askAt, 'checa, pergunta, so entao baixa');
  assert.ok(verifyAt > installAt, 'paridade depois da instalacao — senao reprova quem acabou de baixar');
  assert.ok(queueAt > verifyAt, 'fila so depois de tudo validado');
});
