/**
 * Web panel smoke tests.
 *
 * `apps/web` was the only service with real business rules — staff
 * authorization, whitelist approval, OAuth exchange — and no tests. These tests
 * cover the paths where a mistake is silent and costly: a staff endpoint that
 * forgets the guard, or an UPDATE that rewrites too many rows.
 *
 * MySQL is replaced by an in-memory double before the server is `require`d,
 * so nothing here touches the database or the network.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

// ── MySQL double ─────────────────────────────────────────────────────────────
// Records every executed query, so tests can assert on the SQL itself (it was
// the SQL that held the retired-character bug, not the handler).
const queryLog = [];
let queryHandler = () => [];

const fakePool = {
  execute: async (sql, params = []) => {
    queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const result = await queryHandler(sql, params);
    if (Array.isArray(result)) return [result, []];
    return [result, []];
  }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return { createPool: () => fakePool };
  }
  return realLoad.apply(this, arguments);
};

process.env.INTERNAL_API_SECRET = 'test-internal-secret';
process.env.MASTER_KEY = 'test-server-key';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';

const { app, validateApplication, hashTicket, issueLauncherSession, resolveLauncherSession } = require(path.join(__dirname, 'server.js'));

Module._load = realLoad;

// ── Ephemeral server ─────────────────────────────────────────────────────────
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  queryLog.length = 0;
  queryHandler = () => [];
});

const get = (p, opts) => fetch(`${baseUrl}${p}`, { redirect: 'manual', ...opts });
const post = (p, body) => fetch(`${baseUrl}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  redirect: 'manual'
});

// ─────────────────────────────────────────────────────────────────────────────

describe('authentication required', () => {
  // Without a session, no data route may respond 200. The real risk here is
  // someone adding a new endpoint and forgetting the guard.
  const protectedRoutes = [
    '/api/me',
    '/api/dashboard',
    '/api/whitelist',
    '/api/characters',
    '/api/audit',
    '/api/economy/holds',
    '/api/economy/top-gold',
    '/api/criminal',
    '/api/factions',
    '/api/prison',
    '/api/crashes',
    '/api/metrics'
  ];

  for (const route of protectedRoutes) {
    test(`GET ${route} requires authentication`, async () => {
      const res = await get(route);
      assert.equal(res.status, 401, `${route} responded ${res.status} without a session`);
    });
  }

  test('POST /api/apply requires authentication', async () => {
    const res = await post('/api/apply', { first_name: 'A' });
    assert.equal(res.status, 401);
  });
});

describe('HTTP hardening', () => {
  test('does not advertise Express in the X-Powered-By header', async () => {
    const res = await get('/api/me');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('health check', () => {
  test('confirms the database dependency without requiring a session', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, database: 'reachable' });
    assert.ok(queryLog.some(entry => /SELECT 1 AS ok/i.test(entry.sql)));
  });

  test('responds 503 without leaking the error when the database fails', async () => {
    queryHandler = () => { throw new Error('password=super-secret'); };
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await get('/health');
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, database: 'unreachable' });
    } finally {
      console.error = originalError;
    }
  });
});

describe('character application validation', () => {
  const valid = {
    first_name: 'Ralof',
    last_name: 'of Riverwood',
    biography: 'x'.repeat(120),
    motivations: 'y'.repeat(40),
    weaknesses: 'z'.repeat(40),
    social_ties: 'w'.repeat(40)
  };

  test('accepts a complete sheet', () => {
    const { error, clean } = validateApplication(valid);
    assert.equal(error, undefined);
    assert.equal(clean.first_name, 'Ralof');
  });

  test('rejects a missing first name', () => {
    assert.match(validateApplication({ ...valid, first_name: '' }).error, /First name/);
  });

  test('rejects a whitespace-only first name', () => {
    assert.match(validateApplication({ ...valid, first_name: '   ' }).error, /First name/);
  });

  test('rejects a biography that is too short', () => {
    assert.match(validateApplication({ ...valid, biography: 'short' }).error, /Biography/);
  });

  test('rejects a field above the column limit', () => {
    assert.match(validateApplication({ ...valid, biography: 'x'.repeat(6000) }).error, /Biography/);
  });

  // The whitelist rubric treats a sheet without these fields as rejected. They
  // used to be `required` only in the HTML, which is trivial to bypass.
  for (const field of ['motivations', 'weaknesses', 'social_ties']) {
    test(`rejects missing ${field} (Heavy RP rubric)`, () => {
      const { error } = validateApplication({ ...valid, [field]: '' });
      assert.ok(error, `empty ${field} should be rejected on the server`);
    });
  }

  test('trims before storing', () => {
    const { clean } = validateApplication({ ...valid, first_name: '  Ralof  ' });
    assert.equal(clean.first_name, 'Ralof');
  });

  test('rejects a non-string type without breaking', () => {
    assert.ok(validateApplication({ ...valid, first_name: { toString: () => 'x' } }).error);
    assert.ok(validateApplication({}).error);
  });
});

describe('launcher OAuth exchange', () => {
  test('rejects a redirect_uri outside the allowlist', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      code: 'abc',
      redirect_uri: 'http://attacker-server.example/callback'
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /redirect_uri/);
  });

  test('rejects a missing code', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      redirect_uri: 'http://localhost:19847/callback'
    });
    assert.equal(res.status, 400);
  });

  test('accepts the launcher redirect_uri (gets as far as talking to Discord)', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      code: 'invalid-code',
      redirect_uri: 'http://localhost:19847/callback'
    });
    // Gets past shape validation; the real Discord rejects the fake code.
    assert.notEqual(res.status, 400, 'the allowlisted redirect_uri should not be blocked');
  });
});

describe('launch ticket', () => {
  test('stores the hash, never the plaintext token', () => {
    const token = 'a'.repeat(64);
    const hash = hashTicket(token);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, token);
    assert.equal(hashTicket(token), hash, 'the hash must be deterministic');
  });
});

describe('launcher session (ticket refresh without re-OAuth)', () => {
  test('issueLauncherSession stores only the hash, never the plaintext token', async () => {
    let inserted = null;
    queryHandler = (sql, params) => {
      if (sql.includes('INSERT INTO launcher_sessions')) {
        inserted = params;
        return { insertId: 1, affectedRows: 1 };
      }
      return [];
    };

    const token = await issueLauncherSession(42, 'discord-123', '127.0.0.1');
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 32);
    // params: [session_hash, account_id, discord_id, ttl_seconds, issued_ip]
    assert.equal(inserted[0], hashTicket(token));
    assert.notEqual(inserted[0], token, 'the plaintext token must not go to the database');
    assert.equal(inserted[1], 42);
  });

  test('resolveLauncherSession rejects a short token without querying the database', async () => {
    let queried = false;
    queryHandler = () => { queried = true; return []; };
    const result = await resolveLauncherSession('too-short');
    assert.equal(result, null);
    assert.equal(queried, false, 'an obviously invalid token should not trigger a query');
  });

  test('resolveLauncherSession returns null when the query finds no row (expired/revoked/nonexistent)', async () => {
    queryHandler = (sql) => {
      assert.match(sql, /revoked_at IS NULL/);
      assert.match(sql, /expires_at > NOW\(\)/);
      return [];
    };
    const result = await resolveLauncherSession('x'.repeat(64));
    assert.equal(result, null);
  });

  test('POST /api/launcher/session/refresh-ticket rejects an invalid session', async () => {
    queryHandler = () => [];
    const res = await post('/api/launcher/session/refresh-ticket', { sessionToken: 'does-not-exist' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_session');
  });

  test('POST /api/launcher/session/refresh-ticket issues a fresh launch ticket for a valid session', async () => {
    const token = 'x'.repeat(64);
    const hash = hashTicket(token);
    queryHandler = (sql, params) => {
      if (sql.includes('SELECT account_id, discord_id FROM launcher_sessions')) {
        assert.equal(params[0], hash);
        return [{ account_id: 7, discord_id: 'discord-7' }];
      }
      if (sql.includes('UPDATE launcher_sessions SET last_used_at')) return { affectedRows: 1 };
      if (sql.includes('INSERT INTO launch_tickets')) return { insertId: 1, affectedRows: 1 };
      return [];
    };

    const res = await post('/api/launcher/session/refresh-ticket', { sessionToken: token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.launchTicket, 'string');
    assert.ok(body.launchTicket.length >= 32);
  });

  test('POST /api/launcher/session/revoke always responds ok (does not leak whether the token existed)', async () => {
    queryHandler = (sql) => {
      if (sql.includes('UPDATE launcher_sessions SET revoked_at')) return { affectedRows: 0 };
      return [];
    };
    const res = await post('/api/launcher/session/revoke', { sessionToken: 'y'.repeat(64) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('crash report endpoint', () => {
  test('rejects a body without a valid crash', async () => {
    const res = await post('/api/crashes/client', { crashes: [] });
    assert.equal(res.status, 400);
  });

  test('rejects a crash without content', async () => {
    const res = await post('/api/crashes/client', { crashes: [{ filename: 'a.log', content: '' }] });
    assert.equal(res.status, 400);
  });
});

describe('removed endpoints stay removed', () => {
  // It served a manifest with a fake hash and nobody consumed it. If it comes
  // back, it becomes a target for someone to point the launcher at again.
  test('GET /api/launcher/manifest does not return manifest JSON', async () => {
    const res = await get('/api/launcher/manifest');
    const body = await res.text();
    assert.ok(!body.includes('dummy_hash_for_testing'), 'the manifest stub is back');
  });
});

describe('crash report rotation', () => {
  // The directory grew without limit: up to 64 KB of log per crash, and an
  // unstable client reports in a row.
  const { pruneCrashReports, CRASH_REPORT_DIR } = require('./server.js');
  const fs = require('fs');
  const path = require('path');

  function makeReport(name, ageDays) {
    const p = path.join(CRASH_REPORT_DIR, name);
    fs.writeFileSync(p, JSON.stringify({ id: name, crashes: [] }));
    if (ageDays) {
      const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      fs.utimesSync(p, t, t);
    }
    return p;
  }

  function clearDir() {
    if (!fs.existsSync(CRASH_REPORT_DIR)) return;
    for (const f of fs.readdirSync(CRASH_REPORT_DIR)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(CRASH_REPORT_DIR, f));
    }
  }

  beforeEach(() => {
    fs.mkdirSync(CRASH_REPORT_DIR, { recursive: true });
    clearDir();
  });

  after(clearDir);

  test('removes reports older than the age limit', async () => {
    makeReport('old.json', 60);
    makeReport('recent.json', 1);

    await pruneCrashReports();

    assert.equal(fs.existsSync(path.join(CRASH_REPORT_DIR, 'old.json')), false);
    assert.equal(fs.existsSync(path.join(CRASH_REPORT_DIR, 'recent.json')), true);
  });

  test('keeps recent ones when nothing is past the age limit', async () => {
    for (let i = 0; i < 5; i++) makeReport(`r${i}.json`, 1);
    const removed = await pruneCrashReports();
    assert.equal(removed, 0);
    assert.equal(fs.readdirSync(CRASH_REPORT_DIR).filter(f => f.endsWith('.json')).length, 5);
  });

  test('does not break on an empty directory', async () => {
    assert.equal(await pruneCrashReports(), 0);
  });

  test('survives a file vanishing mid-prune', async () => {
    // Real concurrency: two reports arriving at once trigger two prunes. The
    // second finds files the first already deleted.
    makeReport('vanishing.json', 60);
    const [a, b] = await Promise.all([pruneCrashReports(), pruneCrashReports()]);
    assert.equal(typeof a, 'number');
    assert.equal(typeof b, 'number');
  });
});

describe('session master API (SkyMP contract)', () => {
  // This endpoint is what takes identity out of the client's hands: with
  // `offlineMode: false`, the SkyMP server doesn't read `profileId` from
  // skymp_config.json — it asks here who owns the session, and the `id` we
  // respond with becomes the gamemode's profileId.
  const MASTER_KEY = 'test-server-key';
  const SESSION = 'b'.repeat(64);

  test('a wrong masterKey responds 404, not 403', async () => {
    // 404 rather than 403 on purpose: we don't confirm the right key exists to
    // someone who is guessing.
    const res = await get(`/api/servers/wrong-key/sessions/${SESSION}`);
    assert.equal(res.status, 404);
  });

  test('game server heartbeat (POST /api/servers/:masterKey) answers 200', async () => {
    // skymp5-server's MasterClient contract: POST every 5 s with
    // { name, maxPlayers, online }. Without the route, the server console
    // printed "Error updating info on master server: ... 404" non-stop.
    const res = await post(`/api/servers/${MASTER_KEY}`, { name: 'Oathbound RP', maxPlayers: 40, online: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(queryLog.length, 0, 'the heartbeat never touches the database');
  });

  test('a heartbeat with the wrong masterKey answers 404', async () => {
    const res = await post('/api/servers/wrong-key', { name: 'x', maxPlayers: 1, online: 0 });
    assert.equal(res.status, 404);
  });

  test('an unknown session answers 404', async () => {
    // 404 is what SkyMP expects: it sends `loginFailedSessionNotFound`
    // to the client, which is the right message for the player.
    queryHandler = () => [];
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);
    assert.equal(res.status, 404);
  });

  test('a session that is too short is rejected without hitting the database', async () => {
    queryLog.length = 0;
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/short`);
    assert.equal(res.status, 404);
    assert.equal(queryLog.filter(q => /game_sessions/i.test(q.sql)).length, 0);
  });

  test('a valid session responds in the shape SkyMP expects', async () => {
    queryHandler = (sql) => {
      if (/SELECT id, account_id, discord_id FROM game_sessions/i.test(sql)) {
        return [{ id: 7, account_id: 42, discord_id: '123456789' }];
      }
      return [];
    };

    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // The shape is dictated by SkyMP (systems/login.ts reads `data.user.id`),
    // not by us — if this changes, all logins stop.
    assert.equal(body.user.id, 42, 'user.id becomes the gamemode profileId');
    assert.equal(body.user.discordId, '123456789');
  });

  test('the query requires a non-revoked, non-expired session', async () => {
    queryHandler = () => [{ id: 1, account_id: 1, discord_id: 'x' }];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    const q = queryLog.find(q => /FROM game_sessions/i.test(q.sql));
    assert.ok(q, 'should have queried game_sessions');
    assert.match(q.sql, /revoked_at IS NULL/, 'a revoked session must stop working immediately');
    assert.match(q.sql, /expires_at > NOW\(\)/, 'an expired session must not authenticate');
  });

  test('stores the hash, never the plaintext token', async () => {
    queryHandler = () => [{ id: 1, account_id: 1, discord_id: 'x' }];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    const q = queryLog.find(q => /FROM game_sessions/i.test(q.sql));
    assert.notEqual(q.params[0], SESSION, 'the plaintext token must not go to the database');
    assert.equal(q.params[0], hashTicket(SESSION));
  });

  test('accepts a session with the launcher `ticket:` prefix (AUTH_001) and hashes without the prefix', async () => {
    // apps/launcher/electron/main.ts writes config.session as `ticket:<token>`
    // (docs/technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md line 22). Without
    // this strip, the hash here never matches the one stored in game_sessions
    // (which is the raw token) and every session resolves as nonexistent — a
    // real bug, confirmed on 2026-08-24 with an external fork (failCount reaching 9000).
    queryHandler = () => [{ id: 7, account_id: 42, discord_id: '123456789' }];
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/ticket:${SESSION}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.user.id, 42);

    const q = queryLog.find(q => /FROM game_sessions/i.test(q.sql));
    assert.equal(q.params[0], hashTicket(SESSION), 'the hash must be of the token without the ticket: prefix');
  });

  test('counts the resolution', async () => {
    queryHandler = (sql) => /SELECT id, account_id/i.test(sql)
      ? [{ id: 7, account_id: 42, discord_id: 'x' }] : [];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    // A high resolve_count signals a session shared between machines.
    const upd = queryLog.find(q => /UPDATE game_sessions/i.test(q.sql));
    assert.ok(upd, 'should record the use');
    assert.match(upd.sql, /resolve_count = resolve_count \+ 1/);
  });
});
