const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const { createMysqlSessionStore, expiryFor } = require('./mysqlSessionStore');

class Store extends EventEmitter {}
const sessionModule = { Store };

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => err ? reject(err) : resolve(value));
  });
}

describe('mysql session store', () => {
  it('stores JSON and expiry using a parameterized UPSERT', async () => {
    const calls = [];
    const store = createMysqlSessionStore(sessionModule, {
      now: () => Date.parse('2026-08-24T12:00:00Z'),
      pruneIntervalMs: 0,
      execute: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }]; }
    });
    await call(store, 'set', 'sid-1', { user: { id: 7 }, cookie: { maxAge: 60_000 } });
    assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
    assert.equal(calls[0].params[0], 'sid-1');
    assert.deepEqual(JSON.parse(calls[0].params[1]), { user: { id: 7 }, cookie: { maxAge: 60_000 } });
    assert.equal(calls[0].params[2].toISOString(), '2026-08-24T12:01:00.000Z');
  });

  it('reads a valid session and handles absence without fabricating one', async () => {
    const rows = [[{ data_json: '{"user":{"id":7}}' }], []];
    const store = createMysqlSessionStore(sessionModule, { pruneIntervalMs: 0, execute: async () => rows });
    assert.deepEqual(await call(store, 'get', 'sid-1'), { user: { id: 7 } });

    const empty = createMysqlSessionStore(sessionModule, { pruneIntervalMs: 0, execute: async () => [[], []] });
    assert.equal(await call(empty, 'get', 'missing'), null);
  });

  it('propagates corrupt JSON as an error instead of partially authenticating', async () => {
    const store = createMysqlSessionStore(sessionModule, {
      pruneIntervalMs: 0,
      execute: async () => [[{ data_json: '{broken' }], []]
    });
    await assert.rejects(call(store, 'get', 'sid-1'), /JSON/);
  });

  it('destroy, touch and prune use parameterized queries', async () => {
    const calls = [];
    const store = createMysqlSessionStore(sessionModule, {
      now: () => 1_000,
      pruneIntervalMs: 0,
      execute: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 2 }]; }
    });
    await call(store, 'touch', 'sid-1', { cookie: { maxAge: 5_000 } });
    await call(store, 'destroy', 'sid-1');
    assert.equal(await store.pruneExpired(), 2);
    assert.match(calls[0].sql, /^UPDATE web_sessions/);
    assert.match(calls[1].sql, /^DELETE FROM web_sessions WHERE session_id/);
    assert.match(calls[2].sql, /^DELETE FROM web_sessions WHERE expires_at/);
    assert.ok(calls.every(entry => !entry.sql.includes('sid-1')));
  });

  it('prefers an explicit expires and falls back to a safe TTL', () => {
    const explicit = expiryFor({ cookie: { expires: '2026-08-25T00:00:00Z' } }, () => 0, 1000);
    assert.equal(explicit.toISOString(), '2026-08-25T00:00:00.000Z');
    assert.equal(expiryFor({}, () => 1_000, 5_000).getTime(), 6_000);
  });
});
