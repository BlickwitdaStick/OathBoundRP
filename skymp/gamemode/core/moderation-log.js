/**
 * core/moderation-log.js
 *
 * Notifies the Discord bot when a moderation action happens in game.
 *
 * The real record is still `audit_logs`, written by
 * `admin-service` in the same flow as the action. This is a **notification** — it lets
 * staff see it happen without opening the panel. See `apps/bot-discord/moderationLog.js`
 * and `docs/ARCHITECTURE.md` 1.3.
 *
 * ─── Three decisions, and why ────────────────────────────────────────────────
 *
 * **1. Core `http.request`, not `fetch`.** The gamemode runs inside the Node that
 * SkyMP embeds, and we do not control its version — global `fetch` only exists
 * from Node 18 on. A new dependency was also out: the gamemode's `package.json`
 * has three, and each one has to resolve from
 * `skymp/gamemode/node_modules` because the entry file runs from `%TEMP%`.
 *
 * **2. Fire and forget.** No function here is `await`ed by whoever moderates.
 * A `/permakill` must not get slow or fail because Discord is down, and
 * the consequence of the action is already in the DB before this call goes out.
 *
 * **3. Off by default.** Without `BOT_INTERNAL_URL` and `INTERNAL_API_SECRET` in
 * the gamemode's `.env`, `notify()` returns on the first line. A server that does not want
 * the channel pays nothing, and sees no error at all.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** Short on purpose: it is a notification, and nobody is waiting for it. */
const TIMEOUT_MS = 3000;

let _avisouQueEstaDesligado = false;

/**
 * @param {object} evento
 * @param {'ban'|'kick'|'permakill'|'whitelist_approve'|'whitelist_reject'|'whitelist_reset'} evento.kind
 * @param {string}  evento.target     who the action was applied to (character name, id)
 * @param {string} [evento.moderator] who applied it
 * @param {string} [evento.reason]
 */
function notify(evento) {
  const base = process.env.BOT_INTERNAL_URL;
  const secret = process.env.INTERNAL_API_SECRET;

  if (!base || !secret) {
    // Once per boot, not per event: its absence is a valid operational
    // choice, and screaming on every kick would turn it into noise staff
    // learn to ignore — which is how a real warning goes unnoticed.
    if (!_avisouQueEstaDesligado) {
      console.log('[moderation-log] Off (BOT_INTERNAL_URL or INTERNAL_API_SECRET missing from .env).');
      _avisouQueEstaDesligado = true;
    }
    return;
  }

  let alvo;
  try {
    alvo = new URL('/api/moderation-log', base);
  } catch (err) {
    console.error(`[moderation-log] BOT_INTERNAL_URL invalida ('${base}'):`, err.message);
    return;
  }

  const corpo = Buffer.from(JSON.stringify({ ...evento, source: 'gamemode', at: new Date().toISOString() }), 'utf8');
  const transporte = alvo.protocol === 'https:' ? https : http;

  const req = transporte.request(
    {
      hostname: alvo.hostname,
      port: alvo.port || (alvo.protocol === 'https:' ? 443 : 80),
      path: alvo.pathname,
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': corpo.length,
        'X-Internal-Secret': secret
      }
    },
    (res) => {
      // The body is drained and discarded: without this the socket stays stuck until the
      // timeout, and on a server with active moderation that leaks connections.
      res.resume();
      if (res.statusCode >= 400) {
        console.error(`[moderation-log] Bot recusou o evento '${evento.kind}': HTTP ${res.statusCode}`);
      }
    }
  );

  req.on('timeout', () => req.destroy(new Error(`no response in ${TIMEOUT_MS}ms`)));
  req.on('error', (err) => {
    // Never propagates. The moderation action already happened and is in `audit_logs`;
    // Discord being down must not undo anything nor show up for the player.
    console.error(`[moderation-log] Failed to notify the bot about '${evento.kind}':`, err.message);
  });

  req.end(corpo);
}

module.exports = { notify };
