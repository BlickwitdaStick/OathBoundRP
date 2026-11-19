/**
 * apps/game-api — game server API (port 7758)
 *
 * The launcher had always called these endpoints; the service just didn't
 * exist. Meanwhile, `verify-mods` always failed with "server offline" and the
 * queue never answered — meaning the modpack parity check, which is the basis
 * of the Server Authority rule, never actually ran.
 *
 * Public endpoints (called by the player's launcher):
 *   GET  /mods.json             → parity manifest { mods, loadOrder }
 *   POST /api/queue/join        → { ticket } → joins the queue
 *   POST /api/queue/status      → { ticket } → position or session ticket
 *   GET  /health                → diagnostics
 *
 * Internal endpoints (X-Internal-Secret, called by the gamemode):
 *   POST /internal/session/resolve   → validates a session ticket and marks it connected
 *   POST /internal/session/release   → frees the slot on disconnect
 *
 * Why the queue doesn't accept `discordId` directly: `discordId` is public. The
 * launcher presents a ticket issued by the panel (which holds the Discord
 * client secret and is therefore the only one able to prove that Discord user
 * really authenticated). See migration-v6-launch-tickets.sql.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const { createMemoryRateLimiter } = require('./rateLimiter');
const express = require('express');
const mysql = require('mysql2/promise');
const { createRuntimeMetrics } = require('../shared/runtimeMetrics');

const { createQueue } = require('./queue');
const { createManifestLoader } = require('./modsManifest');

const app = express();
const runtimeMetrics = createRuntimeMetrics({ service: 'game-api' });
app.disable('x-powered-by');
app.use(runtimeMetrics.middleware);
app.use(express.json({ limit: '64kb' }));

const PORT = parseInt(process.env.GAME_API_PORT || '7758', 10);
const HOST = process.env.GAME_API_BIND_HOST || '0.0.0.0';
const MANIFEST_PATH = process.env.MODS_MANIFEST_PATH || path.join(__dirname, 'mods.json');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const INTERNAL_API_SECRET = requireEnv('INTERNAL_API_SECRET');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'skymp_rp',
  waitForConnections: true,
  connectionLimit: 5
});

const executeDb = (sql, params = []) => runtimeMetrics.timeDb(() => pool.execute(sql, params));

const db = async (sql, params = []) => {
  const [rows] = await executeDb(sql, params);
  return rows;
};

const manifestLoader = createManifestLoader(MANIFEST_PATH);
const queue = createQueue({ capacity: parseInt(process.env.QUEUE_CAPACITY || '40', 10) });

const makeSessionTicket = () => crypto.randomBytes(32).toString('hex');

// How long the game session is valid. It has to cover a whole session, with
// room to reconnect after a crash — the game server queries the master on
// every connection.
const GAME_SESSION_TTL_SECONDS = parseInt(process.env.GAME_SESSION_TTL_SECONDS || String(12 * 60 * 60), 10);

/**
 * Stores the session the game server will resolve against the master API
 * (`apps/web`, `GET /api/servers/:masterKey/sessions/:session`).
 *
 * This record is what stops `profileId` from being a client claim: SkyMP with
 * `offlineMode: false` doesn't read `profileId` from `skymp_config.json`, it
 * asks the master who owns the session.
 *
 * We only store the hash — if the database leaks, in-flight sessions don't
 * become credentials. Same rule as `launch_tickets`.
 */
async function persistGameSession(token, accountId, discordId) {
  await db(
    `INSERT INTO game_sessions (token_hash, account_id, discord_id, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [hashTicket(token), accountId, discordId, GAME_SESSION_TTL_SECONDS]
  );
}

/**
 * Persists the session of whoever was just admitted.
 *
 * The queue is synchronous and in-memory (so it can be tested without a
 * database), so the write happens here, afterwards. If it fails, the admission
 * is rolled back: joining the queue and getting a ticket the game server will
 * refuse would be worse than an honest error — the player would be left
 * watching Skyrim fail to connect without understanding why.
 */
async function persistAdmission(result, identity) {
  if (result.status !== 'success' || !result.ticket) return result;
  try {
    await persistGameSession(result.ticket, identity.accountId, identity.discordId);
    return result;
  } catch (err) {
    console.error('[game-api] Failed to write game_session:', err.message);
    queue.release(identity.accountId, makeSessionTicket);
    return { status: 'error', message: 'session_persist_failed' };
  }
}

// ── In-memory rate limiting, with a global and per-bucket cap ───────────────
const { isRateLimited } = createMemoryRateLimiter();

function isValidInternalSecret(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = Buffer.from(INTERNAL_API_SECRET);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function requireInternal(req, res, next) {
  if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
    runtimeMetrics.recordRejection('internal_secret_invalid');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function hashTicket(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Validates and consumes a launch ticket issued by the panel.
 *
 * The conditional UPDATE is what guarantees single use under concurrency: two
 * simultaneous requests with the same ticket contend for the same row and only
 * one of them sees `affectedRows === 1`. Check-then-mark in two steps would
 * leave a window for both to get through.
 */
async function consumeLaunchTicket(token) {
  if (typeof token !== 'string' || token.length < 32) return null;

  const tokenHash = hashTicket(token);
  const [result] = await executeDb(
    `UPDATE launch_tickets SET consumed_at = NOW()
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (result.affectedRows !== 1) return null;

  const rows = await db('SELECT account_id, discord_id FROM launch_tickets WHERE token_hash = ?', [tokenHash]);
  if (rows.length === 0) return null;
  return { accountId: rows[0].account_id, discordId: rows[0].discord_id };
}

/**
 * Checks that the account is still eligible to join. The ticket proves *who*
 * the person is; this proves they still *may* play — an account may have been
 * banned between the launcher login and joining the queue.
 */
async function isEligible(accountId) {
  const rows = await db(
    `SELECT a.status,
            (SELECT COUNT(*) FROM whitelist_applications w
              WHERE w.account_id = a.id AND w.status = 'approved') AS approved_apps,
            (SELECT COUNT(*) FROM characters c
              WHERE c.account_id = a.id AND c.status = 'approved') AS approved_chars
     FROM accounts a WHERE a.id = ?`,
    [accountId]
  );
  if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
  if (rows[0].status !== 'active') return { ok: false, reason: 'account_not_active' };
  if (Number(rows[0].approved_apps) === 0) return { ok: false, reason: 'not_whitelisted' };
  if (Number(rows[0].approved_chars) === 0) return { ok: false, reason: 'no_approved_character' };
  return { ok: true };
}

// ── Modpack parity ──────────────────────────────────────────────────────────

app.get('/mods.json', (req, res) => {
  const result = manifestLoader.load();
  if (!result.ok) {
    // 503 rather than 200-with-an-empty-list: an empty list would pass the
    // launcher's check and let any modpack in.
    console.error(`[game-api] Manifest unavailable: ${result.reason} (${MANIFEST_PATH})`);
    return res.status(503).json({ error: 'Mod manifest unavailable on the server.' });
  }
  res.json(result.manifest);
});

// ── Queue ───────────────────────────────────────────────────────────────────

app.post('/api/queue/join', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-join:${ip}`, 20, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_queue_join');
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }

  try {
    const identity = await consumeLaunchTicket((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const eligible = await isEligible(identity.accountId);
    if (!eligible.ok) return res.status(403).json({ status: 'error', message: eligible.reason });

    const result = await persistAdmission(
      queue.join(identity.accountId, identity.discordId, makeSessionTicket),
      identity
    );

    // The launcher has to poll the queue again, and the launch ticket was just
    // consumed — so we return a fresh ticket for the next poll.
    if (result.status === 'queued') {
      result.pollTicket = await issuePollTicket(identity.accountId, identity.discordId, ip);
    }

    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/join', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

/**
 * POST rather than GET, and the ticket comes in the body, not the query string.
 *
 * The ticket is a credential: whoever has it joins the queue as that account.
 * Query strings end up in server and proxy access logs; POST bodies don't. The
 * `join` next door always read from the body — this one read from the query,
 * and that was two different treatments of the same secret fourteen lines
 * apart.
 *
 * The impact was smaller than it sounds (the transport is plain HTTP anyway,
 * and tickets rotate and are single-use), but the inconsistency invited
 * mistakes: the next endpoint would copy one of the two, and half the odds
 * were the wrong one.
 *
 * `req.query` is deliberately ignored. The regression test in
 * `server.http.test.js` sends a ticket via the query and requires 401 — if
 * someone reintroduces reading from there, that test breaks.
 */
app.post('/api/queue/status', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-status:${ip}`, 120, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_queue_status');
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }

  try {
    const identity = await consumeLaunchTicket((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const result = await persistAdmission(
      queue.status(identity.accountId, makeSessionTicket),
      identity
    );
    if (result.status === 'queued') {
      result.pollTicket = await issuePollTicket(identity.accountId, identity.discordId, ip);
    }
    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/status', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

/**
 * Issues the ticket for the next poll. Keeps the single-use property (a
 * captured ticket is useless, because it has already been spent) without
 * forcing the player to redo the Discord login every 5 seconds of polling.
 */
async function issuePollTicket(accountId, discordId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  await db(
    `INSERT INTO launch_tickets (token_hash, account_id, discord_id, expires_at, issued_ip)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 300 SECOND), ?)`,
    [hashTicket(token), accountId, discordId, ip || null]
  );
  return token;
}

// ── Internal endpoints (gamemode) ───────────────────────────────────────────

app.post('/internal/session/resolve', requireInternal, (req, res) => {
  const entry = queue.resolveSessionTicket((req.body || {}).ticket);
  if (!entry) return res.status(404).json({ ok: false, error: 'unknown_session' });
  queue.markConnected(entry.accountId);
  res.json({ ok: true, accountId: entry.accountId, discordId: entry.discordId });
});

app.post('/internal/session/release', requireInternal, (req, res) => {
  const accountId = Number((req.body || {}).accountId);
  if (!Number.isInteger(accountId)) return res.status(400).json({ ok: false, error: 'invalid_account_id' });
  const released = queue.release(accountId, makeSessionTicket);
  res.json({ ok: true, released });
});

app.get('/internal/metrics', requireInternal, (req, res) => {
  res.json(runtimeMetrics.snapshot());
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const manifest = manifestLoader.load();
  res.json({
    ok: manifest.ok,
    manifest: manifest.ok
      ? { mods: manifest.manifest.mods.length, plugins: manifest.manifest.loadOrder.length }
      : { error: manifest.reason },
    queue: queue.snapshot()
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[game-api] Running at http://${HOST}:${PORT}`);
    const manifest = manifestLoader.load();
    if (!manifest.ok) {
      console.warn(`[game-api] WARNING: mod manifest unavailable (${manifest.reason}).`);
      console.warn('[game-api] Generate it with: node scripts/generate-mods-manifest.js <path-to-Data>');
      console.warn('[game-api] Until then, /mods.json returns 503 and no player can join.');
    } else {
      console.log(`[game-api] Manifest: ${manifest.manifest.mods.length} files, ${manifest.manifest.loadOrder.length} plugins.`);
    }
  });
}

module.exports = { app, queue, consumeLaunchTicket, isEligible };
