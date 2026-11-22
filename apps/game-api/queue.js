/**
 * queue.js
 *
 * The server's entry queue, with no network or database dependency — everything
 * here is pure in-memory state manipulation, so the admission policy can be
 * tested without spinning anything up.
 *
 * Model: fixed slot capacity. Whoever arrives and finds a free slot gets in
 * directly; whoever doesn't waits in a FIFO queue and is promoted when a slot
 * frees up. A slot frees up when the player disconnects (the gamemode reports
 * it) or when the reservation expires without them showing up in game.
 *
 * Reservation expiry is what keeps the queue from getting stuck: without it, a
 * player who closes the launcher after being admitted would hold the slot
 * forever and the whole queue would be stuck behind them.
 */

// How long an admitted player has to actually enter the game before the slot
// goes back to the queue. It has to cover the Skyrim + SKSE boot, which is not
// fast — hence the generous value.
const DEFAULT_RESERVATION_TTL_MS = 3 * 60 * 1000;

function createQueue(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : 40;
  const reservationTtlMs = options.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS;
  const now = options.now || (() => Date.now());

  // accountId -> { accountId, discordId, sessionTicket, reservedAt, connected }
  const _admitted = new Map();
  // Ordered list of { accountId, discordId, joinedAt }
  let _waiting = [];

  /**
   * Frees slots whose reservations expired without the player connecting.
   * Called at the start of every operation — simpler and more reliable than
   * keeping a timer per reservation.
   */
  function _reapExpired() {
    const t = now();
    for (const [accountId, entry] of _admitted) {
      if (entry.connected) continue;
      if (t - entry.reservedAt > reservationTtlMs) {
        _admitted.delete(accountId);
      }
    }
  }

  function _promoteFromWaiting(makeTicket) {
    while (_admitted.size < capacity && _waiting.length > 0) {
      const next = _waiting.shift();
      _admitted.set(next.accountId, {
        accountId: next.accountId,
        discordId: next.discordId,
        sessionTicket: makeTicket(next.accountId),
        reservedAt: now(),
        connected: false
      });
    }
  }

  /**
   * Requests entry. Idempotent per account: calling twice creates neither two
   * positions nor two slots — the launcher polls, so repetition is the normal
   * case, not the exception.
   *
   * @returns {{status:'success', ticket:string} | {status:'queued', position:number}}
   */
  function join(accountId, discordId, makeTicket) {
    _reapExpired();

    const existing = _admitted.get(accountId);
    if (existing) return { status: 'success', ticket: existing.sessionTicket };

    const waitingIndex = _waiting.findIndex((e) => e.accountId === accountId);
    if (waitingIndex !== -1) {
      _promoteFromWaiting(makeTicket);
      const promoted = _admitted.get(accountId);
      if (promoted) return { status: 'success', ticket: promoted.sessionTicket };
      return { status: 'queued', position: _waiting.findIndex((e) => e.accountId === accountId) + 1 };
    }

    if (_admitted.size < capacity) {
      const ticket = makeTicket(accountId);
      _admitted.set(accountId, { accountId, discordId, sessionTicket: ticket, reservedAt: now(), connected: false });
      return { status: 'success', ticket };
    }

    _waiting.push({ accountId, discordId, joinedAt: now() });
    return { status: 'queued', position: _waiting.length };
  }

  /**
   * Lookup with no join side effect — but it still promotes whoever is
   * waiting, because polling is the only moment we find out a reservation
   * expired.
   */
  function status(accountId, makeTicket) {
    _reapExpired();
    _promoteFromWaiting(makeTicket);

    const admitted = _admitted.get(accountId);
    if (admitted) return { status: 'success', ticket: admitted.sessionTicket };

    const index = _waiting.findIndex((e) => e.accountId === accountId);
    if (index !== -1) return { status: 'queued', position: index + 1 };

    return { status: 'not_queued' };
  }

  /** The gamemode confirms the player entered: the reservation becomes real occupancy. */
  function markConnected(accountId) {
    const entry = _admitted.get(accountId);
    if (!entry) return false;
    entry.connected = true;
    return true;
  }

  /** The gamemode reports the player left: the slot goes back to the queue. */
  function release(accountId, makeTicket) {
    const removed = _admitted.delete(accountId);
    _waiting = _waiting.filter((e) => e.accountId !== accountId);
    if (removed && makeTicket) _promoteFromWaiting(makeTicket);
    return removed;
  }

  /** Validates a session ticket. Used by the gamemode when accepting the connection. */
  function resolveSessionTicket(ticket) {
    if (!ticket) return null;
    for (const entry of _admitted.values()) {
      if (entry.sessionTicket === ticket) return entry;
    }
    return null;
  }

  function snapshot() {
    _reapExpired();
    return {
      capacity,
      occupied: _admitted.size,
      connected: Array.from(_admitted.values()).filter((e) => e.connected).length,
      waiting: _waiting.length
    };
  }

  return { join, status, markConnected, release, resolveSessionTicket, snapshot };
}

module.exports = { createQueue, DEFAULT_RESERVATION_TTL_MS };
