/**
 * HTTP-level tests for `game-api`.
 *
 * They exist because `queue.test.js` tests the queue module, not the routes — so
 * the credential transport (query string versus body, GET versus POST) had no
 * safety net at all. That is how `SEC-QS-01` slipped through.
 *
 * ## Why this runs without MariaDB
 *
 * `consumeLaunchTicket` rejects a missing, non-string or shorter-than-32-character
 * ticket **before** touching the database. Every case here hits that early
 * rejection, so the suite needs no database and doesn't get flaky in CI.
 *
 * The price is the limitation stated below: the happy path can't be tested
 * without a database. The happy path remains the job of a real test session.
 */

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-secret-not-used-here';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('./server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    // Port 0 = the OS picks a free one. A fixed port would make the suite fight
    // with a game-api running on the dev's machine.
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: payload
          ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* a non-JSON body is a valid test result */ }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A plausibly shaped ticket: 64 hex chars, the same length `makeSessionTicket`
// produces. If any route goes back to reading the query string, this value gets
// past the length filter and the behavior changes observably.
const PLAUSIBLE_TICKET = 'a'.repeat(64);

describe('SEC-QS-01 — the ticket does not travel in the query string', () => {
  test('GET /api/queue/status no longer exists', async () => {
    const res = await request('GET', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`);

    // 404 is Express's response for a method with no registered route. If this
    // goes back to 200/401/500, the GET was reintroduced and the ticket is back in the URL.
    assert.equal(res.status, 404, 'GET was reintroduced — the ticket is back in the query string');
  });

  test('POST /api/queue/status ignores a ticket coming from the query string', async () => {
    const res = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });

  test('the query string does not change the response compared with sending no ticket at all', async () => {
    const noTicket = await request('POST', '/api/queue/status', { body: {} });
    const withQuery = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.deepEqual(withQuery.body, noTicket.body);
    assert.equal(withQuery.status, noTicket.status);
  });

  test('POST /api/queue/join also ignores the query string', async () => {
    const res = await request('POST', `/api/queue/join?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });
});

describe('queue — rejects before touching the database', () => {
  for (const [name, body] of [
    ['empty body', {}],
    ['null ticket', { ticket: null }],
    ['numeric ticket', { ticket: 12345678901234567890123456789012 }],
    ['ticket too short', { ticket: 'abc' }],
    ['31-character ticket', { ticket: 'a'.repeat(31) }]
  ]) {
    test(`status rejects ${name} with 401`, async () => {
      const res = await request('POST', '/api/queue/status', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });

    test(`join rejects ${name} with 401`, async () => {
      const res = await request('POST', '/api/queue/join', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });
  }

  test('a request with no body at all does not crash the route', async () => {
    // `express.json()` leaves `req.body` undefined when there is no body. The
    // route does `(req.body || {}).ticket` precisely for that; if someone removes
    // that guard, this becomes a 500.
    const res = await request('POST', '/api/queue/status');
    assert.equal(res.status, 401);
  });
});

describe('internal endpoints require the secret', () => {
  test('session/resolve without X-Internal-Secret returns 401', async () => {
    const res = await request('POST', '/internal/session/resolve', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });

  test('session/release without X-Internal-Secret returns 401', async () => {
    const res = await request('POST', '/internal/session/release', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });

  test('metrics without X-Internal-Secret return 401', async () => {
    const res = await request('GET', '/internal/metrics');
    assert.equal(res.status, 401);
  });

  test('authenticated metrics do not expose the secret and include process/HTTP/DB', async () => {
    const secret = process.env.INTERNAL_API_SECRET;
    const res = await request('GET', '/internal/metrics', {
      headers: { 'X-Internal-Secret': secret, 'X-Request-Id': 'metrics-test-request' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'game-api');
    assert.ok(res.body.process);
    assert.ok(res.body.requests);
    assert.ok(res.body.db);
    assert.doesNotMatch(res.raw, new RegExp(secret));
  });
});

describe('/health responds without a database', () => {
  test('returns the manifest and queue state', async () => {
    const res = await request('GET', '/health');

    assert.equal(res.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'ok'));
    assert.ok(res.body.queue, 'health must expose the queue state');
  });
});

/**
 * ## What this suite does NOT prove
 *
 * - **Nothing on the happy path.** Every case here ends in an early rejection.
 *   A valid ticket, admission, `pollTicket` issuance and session persistence
 *   require MariaDB and still have no automated coverage.
 * - **It doesn't prove the query string is never read when there is a
 *   database.** With a database available, a regression that read
 *   `req.query.ticket` would also return 401 (the ticket wouldn't exist in the
 *   table). What really locks the regression down is the GET 404 test:
 *   reverting the transport without reverting the method is unlikely, and the
 *   method is observable without a database.
 */
