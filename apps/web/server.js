const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../skymp/gamemode/.env') });
const express = require('express');
const session = require('express-session');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { createRuntimeMetrics } = require('../shared/runtimeMetrics');
const { createMysqlSessionStore } = require('./mysqlSessionStore');

const app  = express();
const runtimeMetrics = createRuntimeMetrics({ service: 'web' });
const PORT = process.env.PANEL_PORT || 3001;
const INTERNAL_API_SECRET = requireEnv('INTERNAL_API_SECRET');
// The bot listens on 127.0.0.1 (see apps/bot-discord/index.js). Configurable
// because the panel and the bot don't always run on the same host.
const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || 'http://127.0.0.1:3002';
// Allowlist of redirect_uri values accepted by /api/launcher/oauth/exchange. The
// launcher starts a local callback server on 127.0.0.1:19847 (see electron/main.ts).
const LAUNCHER_REDIRECT_URIS = (process.env.LAUNCHER_REDIRECT_URIS || 'http://localhost:19847/callback,http://127.0.0.1:19847/callback')
  .split(',')
  .map((uri) => uri.trim())
  .filter(Boolean);
const CRASH_REPORT_DIR = path.join(__dirname, 'crash-reports');
// Identifies the game server in SkyMP's master API contract. It must match
// `masterKey` in skymp/config/server-settings.*.json.
const MASTER_KEY = process.env.MASTER_KEY || null;

/** Constant-time comparison, tolerant of different lengths. */
function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

// ── DB Pool ────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASS     || '',
  database: process.env.DB_NAME     || 'skymp_rp',
  waitForConnections: true,
  connectionLimit: 5
});

const executeDb = (sql, params = []) => runtimeMetrics.timeDb(() => pool.execute(sql, params));
const sessionStore = createMysqlSessionStore(session, { execute: executeDb });

const db = async (sql, params = []) => {
  const [rows] = await executeDb(sql, params);
  return rows;
};

const fsp = fs.promises;
const { createMemoryRateLimiter } = require('./rateLimiter');

async function ensureCrashReportDir() {
  await fsp.mkdir(CRASH_REPORT_DIR, { recursive: true });
}

// ── In-memory rate limiting, with a global and per-bucket cap ───────────────
const { isRateLimited } = createMemoryRateLimiter();

function sanitizeCrashText(value, maxLength) {
  return String(value || '').replace(/\0/g, '').slice(0, maxLength);
}

function normalizeCrashReport(body) {
  const crashes = Array.isArray(body.crashes) ? body.crashes.slice(0, 3) : [];
  return {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    receivedAt: new Date().toISOString(),
    discordId: sanitizeCrashText(body.discordId, 64) || null,
    username: sanitizeCrashText(body.username, 120) || null,
    clientVersion: sanitizeCrashText(body.clientVersion, 80) || null,
    launcherVersion: sanitizeCrashText(body.launcherVersion, 80) || null,
    crashes: crashes.map((crash) => ({
      filename: sanitizeCrashText(crash.filename || crash.name, 160).replace(/[\\/:*?"<>|]/g, '_') || 'crash.log',
      mtime: Number(crash.mtime) || null,
      content: sanitizeCrashText(crash.content, 65000)
    })).filter((crash) => crash.content.length > 0)
  };
}

// ── Middleware ─────────────────────────────────────────────────────────────
// Trusting X-Forwarded-For changes the identity the rate limiter uses. That
// has to be an explicit deployment decision, not a side effect of
// NODE_ENV=production on a service that might be exposed without a proxy.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
// The origin used to be a fixed `http://localhost:${PORT}`, which breaks as
// soon as the panel leaves the development machine. In production set the real
// domain in PANEL_PUBLIC_URL (accepts a comma-separated list for apex + www).
const CORS_ORIGINS = (process.env.PANEL_PUBLIC_URL || `http://localhost:${PORT}`)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(runtimeMetrics.middleware);
app.use(express.json({ limit: '512kb' }));
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: sessionStore,
  secret: requireEnv('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8h
  }
}));

// ── Auth via Discord OAuth ───────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: requireEnv('DISCORD_CLIENT_ID'),
    clientSecret: requireEnv('DISCORD_CLIENT_SECRET'),
    // Must match EXACTLY the Redirect URI registered in the Discord developer
    // portal, otherwise authentication fails with `invalid_request`.
    callbackURL: process.env.DISCORD_CALLBACK_URL || `${CORS_ORIGINS[0]}/api/auth/discord/callback`,
    scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const rows = await db('SELECT account_id FROM discord_identities WHERE discord_id = ?', [profile.id]);
        let accountId;
        if (rows.length === 0) {
            const [accRes] = await executeDb('INSERT INTO accounts (status) VALUES (?)', ['active']);
            accountId = accRes.insertId;
            await executeDb('INSERT INTO discord_identities (discord_id, account_id, username, avatar) VALUES (?, ?, ?, ?)', [profile.id, accountId, profile.username, profile.avatar || '']);
        } else {
            accountId = rows[0].account_id;
            await executeDb('UPDATE discord_identities SET username = ?, avatar = ? WHERE discord_id = ?', [profile.username, profile.avatar || '', profile.id]);
        }

        return done(null, { id: profile.id, username: profile.username, avatar: profile.avatar, accountId });
    } catch(err) {
        return done(err, null);
    }
}));

/**
 * WHITELIST_REQUIRED=false opens the server: any Discord user who signs in
 * through the launcher gets an account, and the game makes their character.
 * Anything but an explicit "false" keeps the whitelist on.
 */
function whitelistRequired() {
  return String(process.env.WHITELIST_REQUIRED || '').trim().toLowerCase() !== 'false';
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  runtimeMetrics.recordRejection('auth_required');
  res.status(401).json({ error: 'Not authenticated' });
}

// Staff authority is derived EXCLUSIVELY from the `staff_roles` table.
// The `vip_level` field in `accounts` is ONLY for monetization (VIP/Supporter).
// NEVER use vip_level as a criterion for administrative permission.
async function requireStaff(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    runtimeMetrics.recordRejection('staff_auth_required');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const rows = await db('SELECT role FROM staff_roles WHERE account_id = ? LIMIT 1', [req.user.accountId]);
    if (rows.length === 0) {
      runtimeMetrics.recordRejection('staff_role_required');
      return res.status(403).json({ error: 'Staff access denied' });
    }
    req.staff = { role: rows[0].role };
    return next();
  } catch (err) {
    console.error('[requireStaff]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

app.get('/api/metrics', requireStaff, (req, res) => res.json(runtimeMetrics.snapshot()));

app.get('/health', async (req, res) => {
  try {
    await db('SELECT 1 AS ok');
    return res.json({ ok: true, database: 'reachable' });
  } catch (err) {
    console.error('[health] Database unavailable:', err.message);
    return res.status(503).json({ ok: false, database: 'unreachable' });
  }
});

app.get('/api/auth/discord', passport.authenticate('discord'));
app.get('/api/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/?error=auth_failed'
}), (req, res) => {
    res.redirect('/');
});

app.post('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if(err) { console.error('[logout]', err); return res.status(500).json({ error: 'Internal server error' }); }
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// Public player routes
app.get('/api/me', requireAuth, async (req, res) => {
    try {
        const appRows = await db('SELECT * FROM whitelist_applications WHERE account_id = ? ORDER BY id DESC LIMIT 1', [req.user.accountId]);
        const application = appRows.length > 0 ? appRows[0] : null;
        res.json({
            user: req.user,
            application
        });
    } catch (err) { console.error('[/api/me]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Best-effort heuristic: flags strong concepts so staff look more carefully
// before approving (Heavy RP whitelist rubric). It's not an automatic gate —
// it only sets needs_extra_review for staff to decide during review.
const STRONG_CONCEPT_PATTERN = new RegExp(
  [
    'noble', 'jarl', 'thane',
    'vampir', 'vampire',
    'werewolf',
    'daedra', 'daedric',
    'archmage',
    'assassin',
    'faction leader'
  ].join('|'),
  'i'
);

function detectsStrongConcept(...texts) {
  const combined = texts.filter(Boolean).join(' ');
  return STRONG_CONCEPT_PATTERN.test(combined);
}

// Limits aligned with the schema (VARCHAR/TEXT) and the whitelist rubric: an
// empty or 1-character field is not a character sheet, and a field longer than
// the column type overflows on INSERT and becomes an unexplained 500 for the player.
const APPLY_FIELDS = {
  first_name:  { required: true,  min: 2, max: 60,   label: 'First name' },
  last_name:   { required: true,  min: 2, max: 60,   label: 'Last name' },
  biography:   { required: true,  min: 80, max: 5000, label: 'Biography' },
  // Required on the server too, not just via `required` in apply.html — the
  // form is only the UI, and the whitelist rubric treats a sheet without
  // motivation, weakness or social ties as an outright rejection.
  motivations: { required: true,  min: 30, max: 2000, label: 'Motivations' },
  weaknesses:  { required: true,  min: 30, max: 2000, label: 'Weaknesses' },
  social_ties: { required: true,  min: 30, max: 2000, label: 'Social ties' }
};

function validateApplication(body) {
  const clean = {};
  for (const [field, rule] of Object.entries(APPLY_FIELDS)) {
    const value = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!value) {
      if (rule.required) return { error: `${rule.label} is required.` };
      clean[field] = null;
      continue;
    }
    if (value.length < rule.min) return { error: `${rule.label} needs at least ${rule.min} characters.` };
    if (value.length > rule.max) return { error: `${rule.label} exceeds the ${rule.max}-character limit.` };
    clean[field] = value;
  }
  return { clean };
}

app.post('/api/apply', requireAuth, async (req, res) => {
    const { error: validationError, clean } = validateApplication(req.body || {});
    if (validationError) return res.status(400).json({ error: validationError });
    const { first_name, last_name, biography, motivations, weaknesses, social_ties } = clean;
    try {
        const existing = await db('SELECT status FROM whitelist_applications WHERE account_id = ? ORDER BY id DESC LIMIT 1', [req.user.accountId]);
        if (existing.length > 0 && (existing[0].status === 'pending' || existing[0].status === 'approved')) {
            return res.status(400).json({ error: 'You already have a pending or approved application.' });
        }

        const needsExtraReview = detectsStrongConcept(biography, motivations, weaknesses, social_ties) ? 1 : 0;

        await executeDb(
            `INSERT INTO characters
               (account_id, first_name, last_name, biography, motivations, weaknesses, social_ties, needs_extra_review, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.accountId, first_name, last_name, biography, motivations, weaknesses, social_ties, needsExtraReview, 'pending']
        );

        await executeDb(
            'INSERT INTO whitelist_applications (account_id, status) VALUES (?, ?)',
            [req.user.accountId, 'pending']
        );

        res.json({ ok: true });
    } catch (err) { console.error('[/api/apply]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Dashboard ─────────────────────────────────────────────────────────
app.get('/api/dashboard', requireStaff, async (req, res) => {
  try {
    const [accounts]    = await executeDb('SELECT COUNT(*) as c FROM accounts');
    const [chars]       = await executeDb('SELECT COUNT(*) as c FROM characters');
    const [pending]     = await executeDb("SELECT COUNT(*) as c FROM whitelist_applications WHERE status='pending'");
    // `DATE(created_at)=CURDATE()` wraps the column in a function, which keeps
    // MySQL from using an index — it becomes a full scan of the table, precisely
    // the one that grows fastest in the project. The range comparison makes the
    // same cut and can use `idx_audit_created` (migration v7).
    const [auditToday]  = await executeDb(
      "SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= CURDATE() AND created_at < CURDATE() + INTERVAL 1 DAY"
    );
    const [prisoners]   = await executeDb("SELECT COUNT(*) as c FROM prison_records WHERE status='active'");
    const [factions]    = await executeDb('SELECT COUNT(*) as c FROM factions');
    res.json({
      accounts:    accounts[0].c,
      characters:  chars[0].c,
      pending:     pending[0].c,
      auditToday:  auditToday[0].c,
      prisoners:   prisoners[0].c,
      factions:    factions[0].c,
      gameServer:  currentGameServerStatus()
    });
  } catch (err) { console.error('[/api/dashboard]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Whitelist ─────────────────────────────────────────────────────────
app.get('/api/whitelist', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT wa.id, wa.status, wa.created_at, wa.reviewer_notes,
              d.username as discord_name, d.discord_id,
              c.first_name, c.last_name, c.biography, c.motivations, c.weaknesses,
              c.social_ties, c.needs_extra_review, c.extra_review_notes
       FROM whitelist_applications wa
       LEFT JOIN accounts a ON a.id = wa.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       LEFT JOIN characters c ON c.account_id = a.id
       ORDER BY wa.status='pending' DESC, wa.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/whitelist GET]', err); res.status(500).json({ error: 'Internal server error' }); }
});

/**
 * Sends an event to the Discord moderation log channel (via the bot).
 *
 * Fire and forget: it returns no promise to the caller and swallows every
 * error. The real record is `audit_logs`; the channel is a notification. See
 * `apps/bot-discord/moderationLog.js` and ARCHITECTURE.md 1.3.
 */
function notifyModerationLog(event, requestId) {
    fetch(`${BOT_INTERNAL_URL}/api/moderation-log`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': INTERNAL_API_SECRET,
            'X-Request-Id': requestId
        },
        body: JSON.stringify({ ...event, source: 'panel', at: new Date().toISOString() })
    }).catch(e => console.error('[web] Failed to send moderation log:', e.message));
}

app.patch('/api/whitelist/:id', requireStaff, async (req, res) => {
  const { status, reviewer_notes, extra_review_notes } = req.body;
  const validStatuses = ['approved', 'rejected', 'pending'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db(
      'UPDATE whitelist_applications SET status=?, reviewer_notes=?, reviewed_at=NOW() WHERE id=?',
      [status, reviewer_notes || null, req.params.id]
    );

    // Staff notes about a concept flagged as needs_extra_review (optional).
    if (typeof extra_review_notes === 'string' && extra_review_notes.trim()) {
      await db(
        `UPDATE characters c
         INNER JOIN accounts a ON a.id = c.account_id
         INNER JOIN whitelist_applications wa ON wa.account_id = a.id
         SET c.extra_review_notes=?
         WHERE wa.id=? AND c.status='pending'`, [extra_review_notes.trim(), req.params.id]
      );
    }

    // Look up the related discord_id and account_id to notify the bot and audit
    const idRows = await db(
      `SELECT d.discord_id, a.id as account_id FROM discord_identities d
       INNER JOIN accounts a ON a.id = d.account_id
       INNER JOIN whitelist_applications wa ON wa.account_id = a.id
       WHERE wa.id=?`, [req.params.id]
    );

    // If approved, approve the character too.
    //
    // `c.status='pending'` is mandatory here: without it, the UPDATE sweeps ALL
    // of the account's characters and rewrites the status of any of them —
    // including those staff retired with /permakill (`status='retired'`, see
    // admin-service.retireCharacter). Approving a new sheet used to resurrect
    // the permanently dead character and erase the permakill's consequence.
    if (status === 'approved') {
      await db(
        `UPDATE characters c
         INNER JOIN accounts a ON a.id = c.account_id
         INNER JOIN whitelist_applications wa ON wa.account_id = a.id
         SET c.status='approved'
         WHERE wa.id=? AND c.status='pending'`, [req.params.id]
      );
    }

    // Audit: records who reviewed the whitelist application
    const auditAction = status === 'approved' ? 'whitelist:approve'
      : status === 'rejected' ? 'whitelist:reject'
      : 'whitelist:reset';
    await db(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [auditAction, req.user.accountId, idRows.length > 0 ? idRows[0].account_id : null, reviewer_notes || null]
    );

    // Sync with the Discord bot
    if (idRows.length > 0) {
        try {
            await fetch(`${BOT_INTERNAL_URL}/api/sync-role`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Secret': INTERNAL_API_SECRET,
                    'X-Request-Id': req.requestId
                },
                body: JSON.stringify({ discord_id: idRows[0].discord_id, status })
            });
        } catch (e) {
            console.error('[web] Failed to notify the Discord bot:', e.message);
        }
    }

    // Moderation log in the Discord channel (ARCHITECTURE.md 1.3).
    //
    // Kept separate from the role sync on purpose, rather than one more field
    // in that call: they have different consequences. The sync CHANGES the
    // user's state on Discord and its failure matters; this one is a staff
    // notification and its failure must neither undo nor delay the whitelist
    // decision, which is already stored in the database and audit_logs above.
    //
    // Not `await`ed for the same reason.
    notifyModerationLog({
        kind: status === 'approved' ? 'whitelist_approve'
            : status === 'rejected' ? 'whitelist_reject'
            : 'whitelist_reset',
        target: idRows.length > 0 ? `<@${idRows[0].discord_id}>` : `application #${req.params.id}`,
        moderator: req.user.username || `account #${req.user.accountId}`,
        reason: reviewer_notes || null
    }, req.requestId);

    res.json({ ok: true });
  } catch (err) { console.error('[/api/whitelist PATCH]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Characters ────────────────────────────────────────────────────────
app.get('/api/characters', requireStaff, async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : '%';
    const rows = await db(
      `SELECT c.id, c.first_name, c.last_name, c.status, c.gold, c.created_at,
              d.username as discord_name
       FROM characters c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR d.username LIKE ?
       ORDER BY c.created_at DESC LIMIT 50`,
      [search, search, search]
    );
    res.json(rows);
  } catch (err) { console.error('[/api/characters]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Audit Logs ────────────────────────────────────────────────────────
app.get('/api/audit', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT al.id, al.action, al.details, al.created_at,
              da.username as actor_name, dt.username as target_name
       FROM audit_logs al
       LEFT JOIN accounts a1 ON a1.id = al.actor_account_id
       LEFT JOIN discord_identities da ON da.account_id = a1.id
       LEFT JOIN accounts a2 ON a2.id = al.target_account_id
       LEFT JOIN discord_identities dt ON dt.account_id = a2.id
       ORDER BY al.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/audit]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Economy / Holds ───────────────────────────────────────────────────
app.get('/api/economy/holds', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT h.id, h.name, h.tax_rate, h.treasury,
              f.tag as faction_tag, f.name as faction_name
       FROM holds h
       LEFT JOIN factions f ON f.id = h.ruling_faction_id
       ORDER BY h.name`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/economy/holds]', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/economy/top-gold', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT c.first_name, c.last_name, c.gold, d.username
       FROM characters c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       ORDER BY c.gold DESC LIMIT 10`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/economy/top-gold]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Criminal Records ──────────────────────────────────────────────────
app.get('/api/criminal', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT cr.id, cr.crime, cr.bounty, cr.hold, cr.resolved, cr.created_at,
              c.first_name, c.last_name
       FROM criminal_records cr
       INNER JOIN characters c ON c.id = cr.character_id
       ORDER BY cr.resolved ASC, cr.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/criminal]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Factions ──────────────────────────────────────────────────────────
app.get('/api/factions', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT f.id, f.tag, f.name, f.treasury, f.color_hex, f.created_at,
              COUNT(fm.id) as member_count
       FROM factions f
       LEFT JOIN faction_members fm ON fm.faction_id = f.id
       GROUP BY f.id ORDER BY member_count DESC`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/factions]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── API: Active Prisoners ──────────────────────────────────────────────────
app.get('/api/prison', requireStaff, async (req, res) => {
  try {
    const rows = await db(
      `SELECT pr.id, pr.sentence_minutes, pr.time_served_minutes, pr.crime_summary,
              pr.status, pr.arrested_at,
              c.first_name, c.last_name
       FROM prison_records pr
       INNER JOIN characters c ON c.id = pr.character_id
       WHERE pr.status='active'
       ORDER BY pr.arrested_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/prison]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// API: launcher crash reports
const CRASH_REPORT_MAX_BYTES = 256 * 1024;
const CRASH_REPORT_MAX_FILES = parseInt(process.env.CRASH_REPORT_MAX_FILES || '500', 10);
const CRASH_REPORT_MAX_AGE_DAYS = parseInt(process.env.CRASH_REPORT_MAX_AGE_DAYS || '30', 10);

/**
 * Removes reports that are too old or in excess.
 *
 * Two limits instead of one: age avoids keeping logs from a client version
 * that no longer exists, and the count protects against a flood in a short
 * interval — a crash-loop bug can generate hundreds of reports in the same
 * day, and the age limit alone wouldn't hold that back.
 *
 * A failure here must never take down report intake: losing the prune is
 * irrelevant compared to losing the report.
 */
async function pruneCrashReports() {
  const names = (await fsp.readdir(CRASH_REPORT_DIR)).filter((name) => name.endsWith('.json'));

  const entries = [];
  for (const name of names) {
    const fullPath = path.join(CRASH_REPORT_DIR, name);
    try {
      const stat = await fsp.stat(fullPath);
      entries.push({ fullPath, mtimeMs: stat.mtimeMs });
    } catch { /* vanished midway: nothing to prune */ }
  }

  const cutoff = Date.now() - CRASH_REPORT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const doomed = new Set(entries.filter((e) => e.mtimeMs < cutoff).map((e) => e.fullPath));

  // Newest to oldest; whatever goes past the cap joins the list.
  const survivors = entries
    .filter((e) => !doomed.has(e.fullPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const extra of survivors.slice(CRASH_REPORT_MAX_FILES)) {
    doomed.add(extra.fullPath);
  }

  for (const fullPath of doomed) {
    try { await fsp.unlink(fullPath); } catch { /* concurrency: already gone */ }
  }

  if (doomed.size > 0) {
    console.log(`[crash-reports] ${doomed.size} old report(s) removed.`);
  }
  return doomed.size;
}
app.post('/api/crashes/client', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`crashes:${ip}`, 10, 60 * 1000)) {
      runtimeMetrics.recordRejection('rate_limit_crashes');
      return res.status(429).json({ ok: false, error: 'Too many requests, please try again later.' });
    }

    const contentLength = Number(req.get('content-length') || 0);
    if (contentLength > CRASH_REPORT_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Payload too large' });
    }

    const report = normalizeCrashReport(req.body || {});
    if (report.crashes.length === 0) return res.status(400).json({ ok: false, error: 'No valid crash received' });

    await ensureCrashReportDir();
    const filePath = path.join(CRASH_REPORT_DIR, `${report.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(report, null, 2));

    // Without this the directory grows forever: each report carries up to 64 KB
    // of log per crash, and an unstable client reports in a row. Running it
    // after the write (rather than on a cron) keeps the cleanup tied to its cause.
    pruneCrashReports().catch((err) => console.error('[crash-reports] Failed to prune:', err.message));

    res.json({ ok: true, id: report.id, received: report.crashes.length });
  } catch (err) {
    console.error('[/api/crashes/client]', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.get('/api/crashes', requireStaff, async (req, res) => {
  try {
    await ensureCrashReportDir();
    const names = (await fsp.readdir(CRASH_REPORT_DIR)).filter((name) => name.endsWith('.json'));

    const reports = [];
    for (const name of names) {
      const fullPath = path.join(CRASH_REPORT_DIR, name);
      try {
        const raw = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
        reports.push({
          id: raw.id,
          receivedAt: raw.receivedAt,
          discordId: raw.discordId,
          username: raw.username,
          clientVersion: raw.clientVersion,
          launcherVersion: raw.launcherVersion,
          files: Array.isArray(raw.crashes) ? raw.crashes.map((crash) => ({
            filename: crash.filename,
            mtime: crash.mtime,
            bytes: String(crash.content || '').length
          })) : []
        });
      } catch (fileErr) {
        console.error(`[/api/crashes] Corrupt file skipped: ${name}`, fileErr.message);
      }
    }

    reports.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    res.json(reports.slice(0, 100));
  } catch (err) {
    console.error('[/api/crashes]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Master (SkyMP contract) ─────────────────────────────────────────────
//
// We didn't invent this endpoint: it's the contract the SkyMP server calls
// when `offlineMode: false` (see skymp5-server/ts/systems/login.ts upstream).
// The server takes the `gameData.session` the client sent and asks the master
// who that person is. The `user.id` we respond with becomes the gamemode's
// `profileId`.
//
// That is what takes identity out of the client's hands. Without this
// endpoint, the path is `offlineMode: true`, where the client simply declares
// its own `profileId` in `skymp_config.json` and the server believes it.
//
// SkyMP's default `master` is `https://gateway.skymp.net`. Pointing it at
// our panel only takes changing the string in `server-settings.json` — and it
// makes sense, because the panel is already what authenticates Discord and
// approves the whitelist.
// Game server heartbeat. skymp5-server's MasterClient does
// `POST {master}/api/servers/{masterKey}` with `{ name, maxPlayers, online }`
// every 5 s when `offlineMode: false`. Without this route the server console
// printed "Error updating info on master server: ... status code 404" every
// cycle. We only keep the latest state in memory (shown on the staff
// dashboard); nothing here affects login or sessions.
let gameServerStatus = null;
const GAME_SERVER_STATUS_STALE_MS = 30 * 1000;

app.post('/api/servers/:masterKey', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!MASTER_KEY || !safeEquals(req.params.masterKey, MASTER_KEY)) {
    return res.status(404).json({ error: 'Unknown server' });
  }
  if (isRateLimited(`master-heartbeat:${ip}`, 60, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_master_heartbeat');
    return res.status(429).json({ error: 'Too many requests' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const toCount = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
  gameServerStatus = {
    name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
    maxPlayers: toCount(body.maxPlayers),
    online: toCount(body.online),
    updatedAt: new Date().toISOString()
  };
  return res.json({ ok: true });
});

function currentGameServerStatus() {
  if (!gameServerStatus) return null;
  const ageMs = Date.now() - Date.parse(gameServerStatus.updatedAt);
  return { ...gameServerStatus, stale: ageMs > GAME_SERVER_STATUS_STALE_MS };
}

app.get('/api/servers/:masterKey/sessions/:session', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // Constant-time comparison: the masterKey identifies the game server and
  // must not leak through response-time differences.
  if (!MASTER_KEY || !safeEquals(req.params.masterKey, MASTER_KEY)) {
    console.warn(`[master-api] Invalid masterKey from ${ip}`);
    return res.status(404).json({ error: 'Unknown server' });
  }

  if (isRateLimited(`master-session:${ip}`, 120, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_master_session');
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    // `apps/launcher/electron/main.ts` writes `config.session` as
    // `ticket:<token>` (see docs/technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md
    // line 22) — the prefix is only a client-side format marker; the token
    // stored in `game_sessions` (apps/game-api) is the raw value, without it.
    // Without this strip, every hash here is computed over the wrong string and
    // the session never resolves — a silent, recurring failure confirmed on
    // 2026-08-24 with an external fork (failCount reaching 9000).
    const rawSession = req.params.session;
    const session = typeof rawSession === 'string' && rawSession.startsWith('ticket:')
      ? rawSession.slice('ticket:'.length)
      : rawSession;
    if (typeof session !== 'string' || session.length < 32) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rows = await db(
      `SELECT id, account_id, discord_id FROM game_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [hashTicket(session)]
    );

    // 404 is what SkyMP expects for an invalid session: it sends
    // `loginFailedSessionNotFound` to the client, which is the right message.
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    // Count the use. A high `resolve_count` is a sign of a session shared
    // between machines — worth looking at when it shows up.
    await db(
      'UPDATE game_sessions SET last_resolved_at = NOW(), resolve_count = resolve_count + 1 WHERE id = ?',
      [rows[0].id]
    );

    // The response shape is dictated by SkyMP, not by us: `data.user.id`.
    res.json({ user: { id: rows[0].account_id, discordId: rows[0].discord_id } });
  } catch (err) {
    console.error('[master-api] /sessions', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Launcher ────────────────────────────────────────────────────────────

// Launch ticket lifetime: it only needs to survive from the click on "Play"
// until joining the queue. Short because nothing about it needs to last longer.
const LAUNCH_TICKET_TTL_MS = 5 * 60 * 1000;

function hashTicket(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a single-use ticket bound to an account. Stores only the hash — if
 * the database leaks, in-flight tickets don't become usable credentials.
 */
async function issueLaunchTicket(accountId, discordId, issuedIp) {
  const token = crypto.randomBytes(32).toString('hex');
  await db(
    `INSERT INTO launch_tickets (token_hash, account_id, discord_id, expires_at, issued_ip)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [hashTicket(token), accountId, discordId, Math.floor(LAUNCH_TICKET_TTL_MS / 1000), issuedIp || null]
  );
  return token;
}

// Launcher session: multi-use and long-lived, unlike the launch ticket
// (single-use, ~5 min). It serves exactly one purpose — requesting a new launch
// ticket without repeating the whole Discord OAuth. See
// migration-v25-launcher-sessions.sql for the problem this solves (token error
// after the first match).
const LAUNCHER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Issues a launcher session bound to an account. Stores only the hash. */
async function issueLauncherSession(accountId, discordId, issuedIp) {
  const token = crypto.randomBytes(32).toString('hex');
  await db(
    `INSERT INTO launcher_sessions (session_hash, account_id, discord_id, expires_at, issued_ip)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [hashTicket(token), accountId, discordId, Math.floor(LAUNCHER_SESSION_TTL_MS / 1000), issuedIp || null]
  );
  return token;
}

/** Validates a launcher session. Does not consume it — it's multi-use until it expires or is revoked. */
async function resolveLauncherSession(token) {
  if (typeof token !== 'string' || token.length < 32) return null;
  const rows = await db(
    `SELECT account_id, discord_id FROM launcher_sessions
     WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashTicket(token)]
  );
  if (rows.length === 0) return null;
  return { accountId: rows[0].account_id, discordId: rows[0].discord_id };
}


// Exchange of the Discord OAuth `code` for a profile, done by the panel.
//
// The launcher is a desktop app distributed to players: any secret embedded in
// it (it used to be `VITE_DISCORD_CLIENT_SECRET`) can be extracted from the
// installer by anyone who downloads the game, and with the secret in hand one
// can impersonate the application on Discord. The secret lives only here, on
// the server.
//
// The launcher sends `{ code, redirect_uri }` and gets back only the user's
// public data — never the Discord access_token, which has no use on its side
// and would only widen the leak surface.
app.post('/api/launcher/oauth/exchange', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`oauth-exchange:${ip}`, 10, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_oauth_exchange');
    return res.status(429).json({ error: 'Too many attempts, please wait a minute.' });
  }

  const { code, redirect_uri } = req.body || {};
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'missing code' });
  if (typeof redirect_uri !== 'string' || !redirect_uri) return res.status(400).json({ error: 'missing redirect_uri' });

  // We only accept the redirect_uri values we registered ourselves. Without
  // this, a stolen code could be exchanged pointing to a third-party address.
  if (!LAUNCHER_REDIRECT_URIS.includes(redirect_uri)) {
    return res.status(400).json({ error: 'redirect_uri not allowed' });
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri
      })
    });

    if (!tokenRes.ok) return res.status(401).json({ error: 'Failed to authenticate with Discord.' });
    const token = await tokenRes.json();
    if (!token.access_token) return res.status(401).json({ error: 'Failed to authenticate with Discord.' });

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Failed to read the Discord profile.' });
    const user = await userRes.json();
    if (!user.id) return res.status(401).json({ error: 'Failed to read the Discord profile.' });

    // The account has to exist before a ticket is issued — someone who never
    // went through the panel has no whitelist, so has nothing to do in the queue.
    const accountRows = await db('SELECT account_id FROM discord_identities WHERE discord_id = ?', [user.id]);
    let accountId = accountRows.length > 0 ? accountRows[0].account_id : null;

    // Whitelist off (WHITELIST_REQUIRED=false): signing in with Discord is
    // enough, so the launcher creates the account the panel would have.
    if (!accountId && !whitelistRequired()) {
      const [accRes] = await executeDb('INSERT INTO accounts (status) VALUES (?)', ['active']);
      accountId = accRes.insertId;
      await executeDb('INSERT INTO discord_identities (discord_id, account_id, username, avatar) VALUES (?, ?, ?, ?)',
        [user.id, accountId, user.global_name || user.username, user.avatar || '']);
    }

    const profile = {
      discordId: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null
    };

    // Only the panel has the client secret, so only it can prove that Discord
    // user really authenticated. The ticket carries that proof to the queue
    // (apps/game-api), which would have no way to verify anything on its own.
    if (accountId) {
      profile.launchTicket = await issueLaunchTicket(accountId, user.id, ip);
      profile.sessionToken = await issueLauncherSession(accountId, user.id, ip);
    }

    res.json(profile);
  } catch (err) {
    console.error('[/api/launcher/oauth/exchange]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The launcher trades the session (multi-use, 30 days) for a fresh launch
// ticket (single-use, ~5 min) before each attempt to join the queue — instead
// of resending a ticket the first match already consumed. See
// migration-v25-launcher-sessions.sql.
app.post('/api/launcher/session/refresh-ticket', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`session-refresh:${ip}`, 30, 60 * 1000)) {
    runtimeMetrics.recordRejection('rate_limit_session_refresh');
    return res.status(429).json({ error: 'Too many attempts, please wait a minute.' });
  }

  const { sessionToken } = req.body || {};
  const session = await resolveLauncherSession(sessionToken);
  if (!session) return res.status(401).json({ error: 'invalid_session' });

  try {
    await db(`UPDATE launcher_sessions SET last_used_at = NOW() WHERE session_hash = ?`, [hashTicket(sessionToken)]);
    const launchTicket = await issueLaunchTicket(session.accountId, session.discordId, ip);
    res.json({ launchTicket });
  } catch (err) {
    console.error('[/api/launcher/session/refresh-ticket]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Called on launcher logout. Always responds 200 — it's not up to the launcher
// to know whether the token existed or was already revoked, and there's
// nothing sensitive to hide behind a different error here.
app.post('/api/launcher/session/revoke', async (req, res) => {
  const { sessionToken } = req.body || {};
  if (typeof sessionToken === 'string' && sessionToken.length >= 32) {
    try {
      await db(
        `UPDATE launcher_sessions SET revoked_at = NOW() WHERE session_hash = ? AND revoked_at IS NULL`,
        [hashTicket(sessionToken)]
      );
    } catch (err) {
      console.error('[/api/launcher/session/revoke]', err);
    }
  }
  res.json({ ok: true });
});

// There used to be a `GET /api/launcher/manifest` here that returned a fixed
// manifest with `hash: "dummy_hash_for_testing"`. Nothing consumed it: the real
// launcher (apps/launcher/electron/main.ts) fetches the client and mod
// manifests from GitHub Releases (VITE_GITHUB_DIST_REPO) and modpack parity
// from `http://<SERVER_IP>:<VITE_API_PORT>/mods.json`. Keeping a stub with a
// fake hash on a panel that also serves authentication was just an invitation
// for someone to point the launcher at it. See docs/technical/LAUNCHER_DISTRIBUTION.md.

// ── Catch-all: SPA ─────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Only listens when run directly. Under `require` (tests), it exports the app
// to be mounted on an ephemeral server — without this, importing this file in
// a test would open the real port 3001.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[staff-panel] Panel running at http://localhost:${PORT}`);
  });
}

module.exports = { app, validateApplication, issueLaunchTicket, issueLauncherSession, resolveLauncherSession, hashTicket, pruneCrashReports, CRASH_REPORT_DIR };
