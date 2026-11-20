'use strict';

/**
 * Static characterization of `index.html` — does not run inside CEF (there
 * is no test runner for that in this project). It only confirms that the file
 * still wires the main-menu auth bootstrap (27/08/2026 evidence, corrected on
 * 19/11/2026 after an in-game run): auth-widgets.js is loaded, and the
 * repeating front-loaded handshake starts only in-game.
 *
 * The handshake behaviour itself (install widgets, repeat front-loaded until
 * the client draws the form) is tested in auth-widgets.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const HTML_PATH = path.join(__dirname, 'index.html');
const WIDGETS_PATH = path.join(__dirname, 'auth-widgets.js');

test('index.html loads auth-widgets.js and starts the front-loaded handshake', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scriptIdx = html.indexOf('<script src="auth-widgets.js"></script>');
  const startIdx = html.indexOf('OathboundAuthWidgets.startFrontLoadedHandshake(');

  assert.notStrictEqual(scriptIdx, -1, 'auth-widgets.js must be loaded.');
  assert.notStrictEqual(startIdx, -1,
    'the handshake must start: without front-loaded the native AuthService never ' +
    'draws the authorization form (in-game log: authNeeded but no browserWindowLoaded).');
  assert.ok(scriptIdx < startIdx, 'auth-widgets.js must load before the bootstrap script runs.');
  assert.ok(html.slice(startIdx, startIdx + 200).includes('getPlatform: () => window.skyrimPlatform'),
    'the handshake must read the real bridge lazily, not a snapshot taken at load.');
});

test('the handshake source still sends front-loaded and installs widgets first', () => {
  const js = fs.readFileSync(WIDGETS_PATH, 'utf8');
  const fn = js.slice(js.indexOf('function startFrontLoadedHandshake'));
  const installIdx = fn.indexOf('installOn(platform');
  const sendIdx = fn.indexOf("sendMessage('front-loaded')");
  assert.ok(installIdx !== -1 && sendIdx !== -1 && installIdx < sendIdx,
    'widgets must exist BEFORE front-loaded, which is what makes AuthService draw the form.');
});

test('nothing in the UI auto-sends authAttemptEvent (that is the Play button)', () => {
  // With the launcher-seeded remote session, an automatic authAttemptEvent
  // would connect on game load and skip the authentication screen.
  for (const file of [HTML_PATH, WIDGETS_PATH]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.strictEqual(src.indexOf("sendMessage('authAttemptEvent')"), -1, file);
    assert.strictEqual(src.indexOf('sendMessage("authAttemptEvent")'), -1, file);
  }
});

test('index.html only starts this in-game (RODANDO_FORA_DO_JOGO=false), never in the mock', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const guardIdx = html.indexOf('if (!RODANDO_FORA_DO_JOGO && window.OathboundAuthWidgets) {');
  const startIdx = html.indexOf('OathboundAuthWidgets.startFrontLoadedHandshake(');

  assert.notStrictEqual(guardIdx, -1, 'the RODANDO_FORA_DO_JOGO guard must exist.');
  assert.ok(startIdx > guardIdx && startIdx - guardIdx < 200,
    'the handshake must be inside the !RODANDO_FORA_DO_JOGO block, otherwise the ' +
    'out-of-game mock will also trigger it (the same class of bug fixed on 23/08).');
});

test('index.html wires the F8 admin panel (markup, styles, script after the player panel, key dispatch)', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(html.includes('<link rel="stylesheet" href="admin-panel.css">'));
  assert.ok(html.includes('<div id="admin-panel"'));
  const pp = html.indexOf('<script src="player-panel.js"></script>');
  const ap = html.indexOf('<script src="admin-panel.js"></script>');
  assert.ok(pp !== -1 && ap > pp, 'admin-panel.js reuses the player panel styles and must load after it.');
  const handler = html.slice(html.indexOf('window.handlePlayerShortcutKey = (action) => {'));
  assert.ok(handler.slice(0, 600).includes("action === 'admin:open'"), 'the F8 action must reach the admin panel.');
  for (const id of ['ap-char-query', 'ap-char-retired', 'ap-item-query', 'ap-item-type', 'ap-item-count', 'ap-item-target', 'ap-item-give',
    'ap-creature-query', 'ap-creature-spawn', 'ap-players-refresh', 'ap-close', 'ap-result']) {
    assert.ok(html.includes(`id="${id}"`), `admin-panel.js needs #${id}`);
  }
});
