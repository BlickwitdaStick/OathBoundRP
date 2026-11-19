/**
 * core/player-shortcuts-service.js
 *
 * `F2` key to open `/panel` without typing — same goal as the `[E]` prompt
 * (Task 11), applied to an action that already exists (`panel:open`, see
 * `player-panel-service.js`) and does not depend on any target.
 *
 * ─── Why its own module, and not inside `interaction-prompt` ───────────────
 *
 * `interaction-prompt-service.js` already proves the pattern "register `keyPress`
 * once, via a guard in `ctx.state`" — but it is behind
 * `ENABLE_INTERACTION_PROMPT`. Tying `F2` to that flag would make opening the
 * panel depend on a lab that has nothing to do with it. This module
 * reuses the SAME pattern (presence tick + guard in `ctx.state`), with its
 * own flag.
 *
 * ─── Why there is still a tick, if the target never changes ────────────────
 *
 * Unlike the `[E]` prompt (whose payload changes every 2s as the
 * player walks), here the "payload" is always the same — it only exists to give the
 * client ONE `mp.set` that fires `updateOwner` and registers the key
 * listener. `commands.listActiveActorIds()` guarantees every active character
 * receives that send once; diffing (`_ultimoEnvio`, same mechanism as the
 * `[E]` prompt) guarantees it is not resent on every tick after that.
 *
 * ⚠️ NOT VALIDATED IN GAME — same caveat as this project's whole family of
 * labs. `ctx.sp.on('keyPress', ...)` is the same mechanism as `[E]`
 * (never confirmed against a real SkyMP server); the `F2` scan code
 * (`60`, 0x3C) is a DirectInput table lookup, not a test.
 */

'use strict';

const commands = require('../commands');

/** Property through which the "ready signal" reaches the client. */
const PROPERTY = 'playerShortcuts';

/** F2 = DirectInput scan code 60 (0x3C). See the caveat in the header. */
const SCAN_CODE_F2 = 60;

/**
 * Runs on the client, inside Skyrim Platform. It has a single responsibility:
 * register (once, guarded in `ctx.state`, same pattern as
 * `interaction-prompt-service.js`) the `F2` listener that asks the server
 * to open the panel — through the SAME path any UI click already uses
 * (`window.skyrimPlatform.sendMessage`, see `core/ui-event-gateway.js`),
 * not a new path.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.state.playerShortcuts = ctx.state.playerShortcuts || { registrouTecla: false };
  var psc = ctx.state.playerShortcuts;

  if (!psc.registrouTecla && ctx.sp && typeof ctx.sp.on === 'function') {
    psc.registrouTecla = true;
    ctx.sp.on('keyPress', function (key) {
      if (key !== ${SCAN_CODE_F2}) return; // F2
      if (!ctx.sp.browser || !ctx.sp.browser.executeJavaScript) return;
      ctx.sp.browser.executeJavaScript('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("panel:open")');
    });
  }
`;

/** Same interval as the `[E]` prompt and the nametag — not time-critical here. */
const INTERVALO_DO_TICK_MS = 2000;

let _timer = null;

/** actorId -> has already received the ready signal (avoids resending every tick). */
const _jaEnviado = new Set();

async function tick() {
  if (typeof mp === 'undefined') return;

  const presentes = new Set(commands.listActiveActorIds());
  for (const actorId of _jaEnviado) {
    if (!presentes.has(actorId)) _jaEnviado.delete(actorId);
  }

  for (const actorId of presentes) {
    if (_jaEnviado.has(actorId)) continue;
    _jaEnviado.add(actorId);
    try {
      mp.set(actorId, PROPERTY, { sentAt: Date.now() });
    } catch (err) {
      console.error(`[player-shortcuts] Failed to send signal to 0x${actorId.toString(16)}:`, err.message);
    }
  }
}

function initPlayerShortcutsService() {
  if (_timer) return;
  _timer = setInterval(() => {
    tick().catch((err) => console.error('[player-shortcuts] Tick failed:', err.message));
  }, INTERVALO_DO_TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[player-shortcuts] F2 opens /panel. NOT validated in game — see the file header.');
}

function shutdownPlayerShortcutsService() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _jaEnviado.clear();
}

module.exports = {
  PROPERTY,
  SNIPPET_DO_CLIENTE,
  SCAN_CODE_F2,
  INTERVALO_DO_TICK_MS,
  tick,
  initPlayerShortcutsService,
  shutdownPlayerShortcutsService,
  _jaEnviado
};
