/**
 * Counter per sender and event type from the CEF.
 *
 * By default it only measures: the limit stays off until there are metrics from
 * a real session. Once operations set both environment values, the
 * same component starts rejecting deterministically and auditably.
 *
 * ─── Per-type policy (2026-08-13) ───────────────────────────────────────────
 *
 * The global cap is still the default, and still off. What now
 * exists is the possibility of a type having its own.
 *
 * The case that forced this is the two Interaction Framework events, which have
 * opposite profiles: `interaction:query` happens every time someone aims at
 * someone — dozens per minute, cheap, no side effects —, and
 * `interaction:execute` moves gold and inventory — a handful per minute, expensive,
 * irreversible. A single cap either chokes the query or lets execution through.
 *
 * The policy is **optional and per type**: with no entry in the map, the type falls back to the
 * usual global behavior. That keeps the discipline this file already
 * had — measure before limiting — for every type that has not been measured yet.
 */

const DEFAULT_WINDOW_MS = 60_000;

function positiveIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveIntegerOrZero(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * @param {{
 *   windowMs?: number,
 *   maxEvents?: number,
 *   policies?: Record<string, {maxEvents?: number, windowMs?: number}>,
 *   now?: () => number
 * }} [options]
 */
function createUiEventRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  maxEvents = 0,
  policies = {},
  now = Date.now
} = {}) {
  const resolvedWindowMs = positiveIntegerOr(windowMs, DEFAULT_WINDOW_MS);
  const resolvedMaxEvents = positiveIntegerOrZero(maxEvents);

  // Resolved once in the constructor, not on every event: the hot path is
  // a `Map` read, not a reinterpretation of configuration.
  /** @type {Map<string, {maxEvents: number, windowMs: number}>} */
  const resolvedPolicies = new Map();
  for (const [type, policy] of Object.entries(policies || {})) {
    resolvedPolicies.set(type, {
      maxEvents: policy && policy.maxEvents !== undefined
        ? positiveIntegerOrZero(policy.maxEvents)
        : resolvedMaxEvents,
      windowMs: policy && policy.windowMs !== undefined
        ? positiveIntegerOr(policy.windowMs, resolvedWindowMs)
        : resolvedWindowMs
    });
  }

  const buckets = new Map();
  const metrics = { observed: 0, rejected: 0, byType: new Map(), rejectedByType: new Map() };

  function policyFor(type) {
    return resolvedPolicies.get(type) || { maxEvents: resolvedMaxEvents, windowMs: resolvedWindowMs };
  }

  function observe(actorId, type) {
    const timestamp = now();
    const policy = policyFor(type);
    const key = `${actorId}:${type}`;
    let bucket = buckets.get(key);
    if (!bucket || timestamp - bucket.startedAt >= policy.windowMs) {
      bucket = { startedAt: timestamp, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    metrics.observed++;
    metrics.byType.set(type, (metrics.byType.get(type) || 0) + 1);

    const allowed = policy.maxEvents === 0 || bucket.count <= policy.maxEvents;
    if (!allowed) {
      metrics.rejected++;
      metrics.rejectedByType.set(type, (metrics.rejectedByType.get(type) || 0) + 1);
    }
    return { allowed, count: bucket.count, limit: policy.maxEvents, windowMs: policy.windowMs };
  }

  function snapshot() {
    return {
      enforcementEnabled: resolvedMaxEvents > 0 ||
        Array.from(resolvedPolicies.values()).some(p => p.maxEvents > 0),
      windowMs: resolvedWindowMs,
      maxEvents: resolvedMaxEvents,
      policies: Object.fromEntries(resolvedPolicies),
      observed: metrics.observed,
      rejected: metrics.rejected,
      byType: Object.fromEntries(metrics.byType),
      rejectedByType: Object.fromEntries(metrics.rejectedByType)
    };
  }

  return { observe, snapshot };
}

module.exports = { createUiEventRateLimiter, DEFAULT_WINDOW_MS };
