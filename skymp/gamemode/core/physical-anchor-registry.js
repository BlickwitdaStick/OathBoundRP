/**
 * core/physical-anchor-registry.js
 *
 * Task 11 — the missing piece for the `[E]` prompt to cover objects (Depot),
 * not only actors. Same spirit as `interaction-registry.js`: the core does not
 * know Depot, Depot is the one that registers here.
 *
 * ─── Why this exists, and not a generic object sweep ───────────────────────
 *
 * Nowhere in the project (nor in SkyMP, checked against the
 * official documentation before this task) is there a "list objects near
 * point X" function — the engine does not expose that without a fork. What DOES exist are
 * small, staff-curated tables of known physical anchors — `depot_
 * terminals` is the first. This file is the single point where such a module
 * announces itself, so `interaction-prompt-service.js` knows whom to
 * ask, without importing `depot-service.js` directly (the core must not
 * know a lab module by name).
 *
 * ─── Provider contract ─────────────────────────────────────────────────────
 *
 * `{ targetType: string, list: () => Promise<Array<{targetId: number}>> }`
 *
 * `list()` returns ALL the anchors of that type — distance filtering
 * is the caller's job (`interaction-prompt-service.js`), because only it knows
 * who is asking. `targetId` must already be a numeric FormID
 * (resolved from a FormDesc by whoever registered — `mp.getIdFromDesc`), because that is
 * the format `interaction-service.peek`/`range-utils` expect.
 */

'use strict';

/** @type {Array<{targetType: string, list: Function}>} */
const _providers = [];
let _snapshot = new Map();

/**
 * @param {{targetType: string, list: () => Promise<Array<{targetId: number}>>}} provider
 */
function register(provider) {
  if (!provider || typeof provider.list !== 'function' || typeof provider.targetType !== 'string') {
    throw new Error('[physical-anchor-registry] provider needs targetType (string) and list() (function).');
  }
  _providers.push(provider);
}

/**
 * Rebuilds the synchronous index used by `mp.onActivate`. The native hook
 * cannot wait on the DB; that is why modules load their anchors at boot and
 * activation does only an O(1) lookup in this snapshot.
 */
async function refresh() {
  const next = new Map();
  for (const anchor of await listAll()) {
    if (!next.has(anchor.targetId)) next.set(anchor.targetId, anchor.targetType);
  }
  _snapshot = next;
  return _snapshot.size;
}

function getTargetType(targetId) {
  return Number.isSafeInteger(targetId) ? (_snapshot.get(targetId) || null) : null;
}

function has(targetId) {
  return getTargetType(targetId) !== null;
}

/**
 * Every anchor from every registered provider, flattened into a single
 * list. A provider that throws does not take down the others — same criterion as
 * `canSee` in `interaction-service.js`: a buggy module does not lock up the rest.
 * @returns {Promise<Array<{targetId: number, targetType: string}>>}
 */
async function listAll() {
  const resultado = [];
  for (const provider of _providers) {
    try {
      const ancoras = await provider.list();
      for (const a of ancoras || []) {
        if (a && Number.isSafeInteger(a.targetId)) {
          resultado.push({ targetId: a.targetId, targetType: provider.targetType });
        }
      }
    } catch (err) {
      console.error(`[physical-anchor-registry] provider for '${provider.targetType}' failed:`, err.message);
    }
  }
  return resultado;
}

/** Test only. */
function _reset() {
  _providers.length = 0;
  _snapshot = new Map();
}

module.exports = { register, listAll, refresh, getTargetType, has, _reset };
