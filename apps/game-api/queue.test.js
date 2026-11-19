const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('./queue');

// Controlled clock — the queue depends on reservation expiry, and testing that
// with real sleeps would make the suite slow and flaky.
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

let ticketCounter = 0;
const makeTicket = () => `ticket-${++ticketCounter}`;

describe('queue — admission within capacity', () => {
  test('admits directly when a slot is free', () => {
    const q = createQueue({ capacity: 2 });
    const res = q.join(1, 'd1', makeTicket);
    assert.equal(res.status, 'success');
    assert.ok(res.ticket);
  });

  test('queues when capacity is exhausted', () => {
    const q = createQueue({ capacity: 1 });
    assert.equal(q.join(1, 'd1', makeTicket).status, 'success');

    const second = q.join(2, 'd2', makeTicket);
    assert.equal(second.status, 'queued');
    assert.equal(second.position, 1);
  });

  test('queue positions follow arrival order', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.join(2, 'd2', makeTicket).position, 1);
    assert.equal(q.join(3, 'd3', makeTicket).position, 2);
  });
});

describe('queue — idempotency (the launcher polls)', () => {
  test('repeated join returns the same ticket, not a new slot', () => {
    const q = createQueue({ capacity: 2 });
    const first = q.join(7, 'd7', makeTicket);
    const second = q.join(7, 'd7', makeTicket);

    assert.equal(second.status, 'success');
    assert.equal(second.ticket, first.ticket, 'the ticket must be stable across calls');
    assert.equal(q.snapshot().occupied, 1, 'must not consume two slots for the same account');
  });

  test('repeated join by a queued player does not create a duplicate position', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    q.join(2, 'd2', makeTicket);

    assert.equal(q.join(2, 'd2', makeTicket).position, 1);
    assert.equal(q.snapshot().waiting, 1);
  });
});

describe('queue — slot release', () => {
  test('release promotes the next in line', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    q.join(2, 'd2', makeTicket);

    q.release(1, makeTicket);

    const status = q.status(2, makeTicket);
    assert.equal(status.status, 'success', 'the waiting player should have been promoted');
    assert.equal(q.snapshot().waiting, 0);
  });

  test('releasing a non-admitted player neither breaks nor promotes wrongly', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.release(999, makeTicket), false);
    assert.equal(q.snapshot().occupied, 1);
  });
});

describe('queue — reservation expiry', () => {
  test('the slot of a player who never connected returns to the queue after the TTL', () => {
    const clock = makeClock();
    const q = createQueue({ capacity: 1, reservationTtlMs: 60_000, now: clock.now });

    q.join(1, 'd1', makeTicket);
    assert.equal(q.join(2, 'd2', makeTicket).status, 'queued');

    clock.advance(61_000);

    const status = q.status(2, makeTicket);
    assert.equal(status.status, 'success', 'the abandoned reservation must free the slot');
  });

  test('a connected player does NOT lose the slot to time', () => {
    const clock = makeClock();
    const q = createQueue({ capacity: 1, reservationTtlMs: 60_000, now: clock.now });

    q.join(1, 'd1', makeTicket);
    q.markConnected(1);
    q.join(2, 'd2', makeTicket);

    clock.advance(10 * 60_000);

    assert.equal(q.status(2, makeTicket).status, 'queued', 'a player in session must not be kicked by the queue');
    assert.equal(q.snapshot().connected, 1);
  });
});

describe('queue — session ticket', () => {
  test('resolves a valid ticket and marks connected', () => {
    const q = createQueue({ capacity: 2 });
    const { ticket } = q.join(42, 'd42', makeTicket);

    const entry = q.resolveSessionTicket(ticket);
    assert.equal(entry.accountId, 42);
    assert.equal(entry.discordId, 'd42');

    q.markConnected(42);
    assert.equal(q.snapshot().connected, 1);
  });

  test('an unknown ticket does not resolve', () => {
    const q = createQueue({ capacity: 2 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.resolveSessionTicket('does-not-exist'), null);
    assert.equal(q.resolveSessionTicket(''), null);
    assert.equal(q.resolveSessionTicket(undefined), null);
  });

  test('the ticket stops resolving after release', () => {
    const q = createQueue({ capacity: 2 });
    const { ticket } = q.join(5, 'd5', makeTicket);
    q.release(5, makeTicket);
    assert.equal(q.resolveSessionTicket(ticket), null);
  });
});

describe('queue — status of a player who never joined', () => {
  test('reports not_queued', () => {
    const q = createQueue({ capacity: 2 });
    assert.equal(q.status(123, makeTicket).status, 'not_queued');
  });
});
