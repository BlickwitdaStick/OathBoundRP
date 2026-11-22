/**
 * core/player-shortcuts-service.js
 *
 * Rebindable player keybinds (19/11/2026). Started as "F2 opens /painel";
 * now the single place where key presses become client actions:
 *
 *   panel.open        F2   asks the server to open the player panel
 *   voice.pushToTalk  V    hold to transmit voice (released = muted)
 *   voice.cycleMode   F11  whisper → normal → shout
 *   voice.toggleMute  —    unbound by default
 *   chat.open         Enter
 *   admin.open        F8   staff only: opens the admin panel (admin-panel-service.js)
 *
 * The property also carries `staff` (true when admin-service knows a role for
 * this actor). The snippet opens the admin panel only when it is true, so a
 * player pressing F8 gets nothing; the server checks permissions again on
 * every admin action anyway.
 *
 * Each account's choices live in `account_keybinds` (migration v30, see
 * core/keybinds.js). The server sends the resolved map to the owner through
 * the `playerShortcuts` property; the client snippet below registers ONE
 * `buttonEvent` listener and dispatches to the CEF handlers in index.html.
 * The Controls tab of the panel (ui/player-panel.js) edits them through the
 * `keybinds:*` UI events handled here.
 *
 * Before this, F2 and the voice keys each registered their own listener on
 * `ctx.sp.on('keyPress', ...)` — an event SkyrimPlatform does not have
 * (Data/Platform/Modules/skyrimPlatform.ts only declares 'buttonEvent'), so
 * none of them ever fired in game.
 *
 * ⚠️ Not yet validated in game: verified against the SkyrimPlatform type
 * declarations and with the snippet executed against a fake `ctx.sp`.
 */

'use strict';

const commands = require('../commands');
const keybinds = require('./keybinds');

/** Property through which bindings reach the owner's client. */
const PROPERTY = 'playerShortcuts';

/** `InputDeviceType.Keyboard` in Data/Platform/Modules/skyrimPlatform.ts. */
const KEYBOARD_DEVICE = 0;

/** Kept for compatibility with callers/tests that referenced the F2 code. */
const SCAN_CODE_F2 = keybinds.defaultBindings()['panel.open'];

/** Embedded in the client snippet so keys work before the server's copy arrives. */
const DEFAULT_BINDINGS = keybinds.defaultBindings();

/**
 * Every CEF element that, while it carries the `open` class, needs the mouse
 * and keyboard. Panels share ONE browser focus: closing one of them (chat,
 * F2, F8, F3) used to unfocus the browser even when another was still open —
 * e.g. chat opened over the skills menu, Enter, and the skills menu stayed on
 * screen with no cursor, the game ignoring every key. Now each close asks the
 * page which of these are still open and takes focus back if one is.
 */
const FOCUS_PANEL_IDS = Object.freeze([
  'skills-panel', 'player-panel', 'admin-panel', 'depot-panel',
  'holdstone-panel', 'interaction-menu', 'chat-input-wrap'
]);

/** Message the page sends back when a panel is still open after a close. */
const REFOCUS_MESSAGE = 'ui:refocus';

/** Runs in the CEF page right after a close released focus. */
const STILL_OPEN_CHECK = `(function () {
  var ids = ${JSON.stringify(FOCUS_PANEL_IDS)};
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && el.classList && el.classList.contains('open')) {
      if (window.skyrimPlatform && typeof window.skyrimPlatform.sendMessage === 'function') {
        window.skyrimPlatform.sendMessage({ type: '${REFOCUS_MESSAGE}', data: { panel: ids[i] } });
      }
      return;
    }
  }
})()`;

/**
 * Runs on the client (SkyrimPlatform `updateOwner`, executed repeatedly).
 *  - When the property value changes (new `sentAt`), stores the bindings in
 *    `ctx.state` and mirrors them to the CEF (`window.handleKeybindsUpdate`)
 *    so the Controls tab shows the server's truth.
 *  - Registers a single `buttonEvent` listener, once.
 *  - Ignores key presses while the CEF has focus (the player is typing in
 *    chat or using the panel), except the push-to-talk RELEASE, which always
 *    goes through so voice can never get stuck open.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.state.oathboundKeybinds = ctx.state.oathboundKeybinds || { registered: false, sentAt: null, bindings: null, pttDown: false, pttCode: null, staff: false };
  var kb = ctx.state.oathboundKeybinds;

  if (ctx.value && ctx.value.bindings && ctx.value.sentAt !== kb.sentAt) {
    kb.sentAt = ctx.value.sentAt;
    kb.bindings = ctx.value.bindings;
    kb.staff = ctx.value.staff === true;
    if (ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
      ctx.sp.browser.executeJavaScript('window.handleKeybindsUpdate && window.handleKeybindsUpdate(' + JSON.stringify(kb.bindings) + ')');
    }
  }

  if (!kb.registered && ctx.sp && typeof ctx.sp.on === 'function') {
    kb.registered = true;

    // Closing the panel hands the mouse/keyboard back to the game right here
    // on the client, without waiting for the server to flip browserFocused.
    // Then the page is asked whether another panel is still open; if so it
    // answers ui:refocus and focus comes back (see FOCUS_PANEL_IDS).
    ctx.sp.on('browserMessage', function (e) {
      var m = e && e.arguments && e.arguments[0];
      if (!m || typeof m !== 'object' || !ctx.sp.browser) return;
      var br = ctx.sp.browser;
      if (m.type === 'panel:close' || m.type === 'chat:close' || m.type === 'admin:close' || m.type === 'skills:close') {
        if (br.setFocused) br.setFocused(false);
        if (br.executeJavaScript) br.executeJavaScript(${JSON.stringify(STILL_OPEN_CHECK)});
      } else if (m.type === '${REFOCUS_MESSAGE}') {
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
      }
    });

    // Hide the OATHBOUND HUD (chat, needs, keys, compass) on loading screens.
    ctx.sp.on('menuOpen', function (e) {
      if (e && e.name === 'Loading Menu' && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
        ctx.sp.browser.executeJavaScript('document.body && document.body.classList.add("ob-loading")');
      }
    });
    ctx.sp.on('menuClose', function (e) {
      if (e && e.name === 'Loading Menu' && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
        ctx.sp.browser.executeJavaScript('document.body && document.body.classList.remove("ob-loading")');
      }
    });

    ctx.sp.on('buttonEvent', function (e) {
      if (!e || e.device !== ${KEYBOARD_DEVICE}) return;
      var br = ctx.sp.browser;
      if (!br || !br.executeJavaScript) return;

      if (e.isUp && kb.pttDown && e.code === kb.pttCode) {
        kb.pttDown = false;
        br.executeJavaScript('window.handleVoicePushToTalk && window.handleVoicePushToTalk(false)');
        return;
      }

      // Defaults until the server's copy arrives: F2 must work from the first frame.
      var b = kb.bindings || ${JSON.stringify(DEFAULT_BINDINGS)};
      if (!e.isDown) return;
      if (typeof br.isFocused === 'function' && br.isFocused()) return;

      var code = e.code;
      if (code === b['panel.open']) {
        // Open and focus locally, instantly; the server only fills in data.
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
        br.executeJavaScript('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("panel:open")');
      } else if (code === b['voice.pushToTalk']) {
        kb.pttDown = true;
        kb.pttCode = code;
        br.executeJavaScript('window.handleVoicePushToTalk && window.handleVoicePushToTalk(true)');
      } else if (code === b['voice.cycleMode']) {
        br.executeJavaScript('window.handleVoiceCycleKey && window.handleVoiceCycleKey()');
      } else if (code === b['voice.toggleMute']) {
        br.executeJavaScript('window.handleVoiceMuteKey && window.handleVoiceMuteKey()');
      } else if (code === b['chat.open']) {
        // Chat box: focus the browser so the player can type; Enter/Esc in the
        // box closes it and the browserMessage listener above unfocuses.
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
        br.executeJavaScript('window.openChat && window.openChat()');
      } else if (code === b['skills.open']) {
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
        br.executeJavaScript('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("skills:open")');
      } else if (code === b['admin.open']) {
        // Staff only. For everyone else this key does nothing at all.
        if (!kb.staff) return;
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
        br.executeJavaScript('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("admin:open")');
      }
    });
  }
`;

/** Same cadence as the [E] prompt and nametags — not time-critical. */
const INTERVALO_DO_TICK_MS = 2000;

let _timer = null;
let _db = null;

/** actorId -> JSON of the bindings last sent (diffing, avoids resending). */
const _ultimoEnvio = new Map();

/** actorId -> staff flag last sent (the role loads at login, maybe after the first send). */
const _ultimoStaff = new Map();

/** Staff according to admin-service (lazy require: it needs the database module). */
function isStaff(actorId) {
  try {
    return Boolean(require('../admin-service').getRole(actorId));
  } catch {
    return false;
  }
}

/** accountId -> resolved bindings (avoids a DB read per tick). */
const _cachePorConta = new Map();

/** actorIds whose load is in flight (avoids parallel duplicate reads). */
const _carregando = new Set();

function getDb() {
  if (!_db) _db = require('../database');
  return _db;
}

/** Test seam: inject a `{ query }` double. */
function _setDatabase(db) {
  _db = db;
}

function accountIdOf(actorId) {
  const data = typeof commands.getActiveCharacterData === 'function'
    ? commands.getActiveCharacterData(actorId)
    : null;
  return data && Number.isInteger(data.accountId) ? data.accountId : null;
}

async function bindingsFor(actorId) {
  const accountId = accountIdOf(actorId);
  if (accountId === null) return keybinds.defaultBindings();
  if (_cachePorConta.has(accountId)) return _cachePorConta.get(accountId);
  let bindings;
  try {
    bindings = await keybinds.loadAccountBindings(getDb(), accountId);
  } catch (err) {
    console.error(`[player-shortcuts] Could not load keybinds for account ${accountId}:`, err.message);
    bindings = keybinds.defaultBindings();
  }
  _cachePorConta.set(accountId, bindings);
  return bindings;
}

function sendBindings(actorId, bindings, { force = false } = {}) {
  const json = JSON.stringify(bindings);
  const staff = isStaff(actorId);
  if (!force && _ultimoEnvio.get(actorId) === json && _ultimoStaff.get(actorId) === staff) return;
  _ultimoEnvio.set(actorId, json);
  _ultimoStaff.set(actorId, staff);
  try {
    mp.set(actorId, PROPERTY, { sentAt: Date.now(), bindings, staff });
  } catch (err) {
    console.error(`[player-shortcuts] Failed to send keybinds to 0x${actorId.toString(16)}:`, err.message);
  }
}

async function tick() {
  if (typeof mp === 'undefined') return;

  const presentes = new Set(commands.listActiveActorIds());
  for (const actorId of _ultimoEnvio.keys()) {
    if (!presentes.has(actorId)) { _ultimoEnvio.delete(actorId); _ultimoStaff.delete(actorId); }
  }

  for (const actorId of presentes) {
    if (_carregando.has(actorId)) continue;
    if (_ultimoEnvio.has(actorId) && _ultimoStaff.get(actorId) === isStaff(actorId)) continue;
    _carregando.add(actorId);
    try {
      sendBindings(actorId, await bindingsFor(actorId));
    } finally {
      _carregando.delete(actorId);
    }
  }
}

function notify(actorId, message) {
  if (typeof commands.sendNotification === 'function') commands.sendNotification(actorId, message);
}

/**
 * UI events from the Controls tab:
 *   keybinds:get                     → resend current bindings
 *   keybinds:set { bindings }        → validate, persist, resend
 *   keybinds:reset                   → back to defaults, persist, resend
 */
async function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string') return false;
  const accountId = accountIdOf(actorId);

  switch (uiEvent.type) {
    case 'keybinds:get':
      sendBindings(actorId, await bindingsFor(actorId), { force: true });
      return true;

    case 'keybinds:set': {
      if (accountId === null) { notify(actorId, 'Keybinds: no active character.'); return true; }
      let validated;
      try {
        validated = keybinds.validateBindings(uiEvent.data && uiEvent.data.bindings);
      } catch (err) {
        if (!(err instanceof keybinds.KeybindValidationError)) throw err;
        notify(actorId, `Keybinds not saved: ${err.message}`);
        sendBindings(actorId, await bindingsFor(actorId), { force: true });
        return true;
      }
      try {
        await keybinds.saveAccountBindings(getDb(), accountId, validated);
      } catch (err) {
        console.error(`[player-shortcuts] Failed to save keybinds for account ${accountId}:`, err.message);
        notify(actorId, 'Keybinds not saved: server error.');
        sendBindings(actorId, await bindingsFor(actorId), { force: true });
        return true;
      }
      _cachePorConta.set(accountId, validated);
      sendBindings(actorId, validated, { force: true });
      notify(actorId, 'Keybinds saved.');
      return true;
    }

    case 'keybinds:reset': {
      if (accountId === null) { notify(actorId, 'Keybinds: no active character.'); return true; }
      let defaults;
      try {
        defaults = await keybinds.resetAccountBindings(getDb(), accountId);
      } catch (err) {
        console.error(`[player-shortcuts] Failed to reset keybinds for account ${accountId}:`, err.message);
        notify(actorId, 'Keybinds not reset: server error.');
        return true;
      }
      _cachePorConta.set(accountId, defaults);
      sendBindings(actorId, defaults, { force: true });
      notify(actorId, 'Keybinds reset to defaults.');
      return true;
    }

    default:
      return false;
  }
}

function initPlayerShortcutsService() {
  if (_timer) return;
  _timer = setInterval(() => {
    tick().catch((err) => console.error('[player-shortcuts] Tick failed:', err.message));
  }, INTERVALO_DO_TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[player-shortcuts] Rebindable keys active (F2 panel, V push-to-talk, F11 voice mode by default). Not yet validated in game.');
}

function shutdownPlayerShortcutsService() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _ultimoEnvio.clear();
  _ultimoStaff.clear();
  _cachePorConta.clear();
  _carregando.clear();
}

/**
 * `chat:open` / `chat:close` UI events exist for the CLIENT (the snippet above
 * releases focus on chat:close). Every browser message is also forwarded to the
 * server by the UI-event gateway, so this claims the prefix to keep the router
 * from logging them as unhandled. Typed lines arrive separately as
 * `cef::chat:send` (ui-event-gateway → commands.handleChatInput).
 */
async function handleChatUiEvent(_actorId, uiEvent) {
  return Boolean(uiEvent && (uiEvent.type === 'chat:open' || uiEvent.type === 'chat:close'));
}

/** `ui:refocus` is client-only too (the snippet above); claimed for the router. */
async function handleFocusUiEvent(_actorId, uiEvent) {
  return Boolean(uiEvent && uiEvent.type === REFOCUS_MESSAGE);
}

module.exports = {
  PROPERTY,
  handleChatUiEvent,
  handleFocusUiEvent,
  FOCUS_PANEL_IDS,
  REFOCUS_MESSAGE,
  SNIPPET_DO_CLIENTE,
  SCAN_CODE_F2,
  KEYBOARD_DEVICE,
  INTERVALO_DO_TICK_MS,
  tick,
  handleUiEvent,
  initPlayerShortcutsService,
  shutdownPlayerShortcutsService,
  _ultimoEnvio,
  _cachePorConta,
  _setDatabase
};
