/**
 * core/profession-registry.js
 *
 * The profession catalog, and nothing else.
 *
 * ─── What this file is NOT ──────────────────────────────────────────────────
 *
 * It does not talk to the database, does not know `characterId`, does not know what a grant is.
 * That is `profession-service.js`. This file answers a single question: "which
 * professions exist, and what state is each one in?" — the same way that
 * `core/module-registry.js` answers "which modules exist?" without knowing what
 * each module does internally.
 *
 * ─── `registered` × `enabled` × `gameplayImplemented` ───────────────────────
 *
 * Three flags because they are three different questions, and mixing them up is what
 * Phase 0 asked to avoid (§4 of the professions briefing):
 *
 *   - `registered`           — the profession is in the catalog. Always `true` for
 *                               whatever `get()`/`list()` returns; the distinction exists
 *                               only for `isRegistered()` on a code that
 *                               nobody registered.
 *   - `enabled`               — the profession can be granted TODAY. It is the
 *                               administrative switch: a profession
 *                               disabled here refuses `grantProfession` even if
 *                               it is in the catalog.
 *   - `gameplayImplemented`   — there is an automated system behind it (resource
 *                               node, recipe, contract). Miner has
 *                               the first loop, still behind a feature flag.
 *                               `miner` does not mean mining exists —
 *                               it means staff can already designate someone
 *                               as a miner for RP and progression purposes,
 *                               before any ResourceNode exists.
 *
 * `grantProfession` (in `profession-service.js`) checks `enabled`, never
 * `gameplayImplemented`. Requiring implemented gameplay to grant the profession
 * would invert the natural order of RP: the guild takes on the apprentice before any
 * automation exists for their work.
 *
 * ─── Why this is a registry and not an exported constant ───────────────────
 *
 * Two reasons, and the first is the one that matters now: `_reset()` +
 * `registerBuiltins()` gives tests the same isolation that
 * `core/module-registry.js` already has. The second is the stated goal of §33 of the
 * briefing — allowing a new profession without touching the core — which only exists if
 * there is a `register()` for it to come in through, instead of an array every consumer
 * would need to re-export and concatenate.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Code shape
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, with `_` between words — the same shape as `module-registry` ids. */
const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Known categories. Closed for the same reason `core/audit-event.js`
 * closes `CATEGORIES`: a free-form category becomes, in six months, four spellings of the
 * same thing.
 */
const CATEGORIES = Object.freeze({
  gathering: 'Gathers raw resources from the world (ore, wood, game, crops).',
  crafting: 'Turns raw resources into goods (smelting, smithing, tanning, cooking, enchanting).',
  service: 'Provides a service to other players or the city (stablehand, innkeeper, courier).',
  institutional: 'A post tied to an institution of the world, not to an economic chain.'
});

// ─────────────────────────────────────────────────────────────────────────────
// Registro interno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProfessionDescriptor
 * @property {string} code
 * @property {string} label
 * @property {string} category
 * @property {string} description
 * @property {boolean} enabled
 * @property {boolean} gameplayImplemented
 */

/** @type {Map<string, Readonly<ProfessionDescriptor>>} */
const _professions = new Map();

/**
 * Registers a profession in the catalog.
 *
 * @param {object} descriptor
 * @param {string} descriptor.code                 stable identifier, e.g. `'miner'`
 * @param {string} descriptor.label                display name, e.g. `'Miner'`
 * @param {string} descriptor.category             a key of `CATEGORIES`
 * @param {string} [descriptor.description]
 * @param {boolean} [descriptor.enabled]            default `true`
 * @param {boolean} [descriptor.gameplayImplemented] default `false`
 */
function register(descriptor) {
  const erro = (msg) => { throw new Error(`[profession-registry] ${msg}`); };

  if (!descriptor || typeof descriptor !== 'object') erro('missing descriptor');
  const {
    code, label, category,
    description = '',
    enabled = true,
    gameplayImplemented = false
  } = descriptor;

  if (!CODE_SHAPE.test(String(code))) {
    erro(`invalid code '${code}': expected lowercase, '_' between words (e.g. 'stablehand')`);
  }
  if (!label || typeof label !== 'string') erro(`profession '${code}' has no label`);
  if (!CATEGORIES[category]) {
    erro(`profession '${code}' has category '${category}', which is not in the catalog. Known: ${Object.keys(CATEGORIES).join(', ')}.`);
  }
  if (_professions.has(code)) erro(`profession '${code}' registered twice`);

  _professions.set(code, Object.freeze({
    code, label, category, description,
    enabled: !!enabled,
    gameplayImplemented: !!gameplayImplemented
  }));
}

/** @param {string} code @returns {Readonly<ProfessionDescriptor>|null} */
function get(code) {
  return _professions.get(code) || null;
}

/** Every registered profession, in a stable order (registration order). */
function list() {
  return [..._professions.values()];
}

/** @param {string} code */
function isRegistered(code) {
  return _professions.has(code);
}

/** @param {string} code */
function isEnabled(code) {
  const p = get(code);
  return !!p && p.enabled;
}

/** @param {string} code */
function isGameplayImplemented(code) {
  const p = get(code);
  return !!p && p.gameplayImplemented;
}

/**
 * The check `grantProfession` runs before anything else. It returns a named
 * reason — never a bare boolean — for the same reason as `core/permissions.js
 * .decide`: a silent `false` forces the caller to guess the cause.
 *
 * @param {unknown} code
 * @returns {{ok:true, profession: object}|{ok:false, reason:'unknown_profession'|'profession_disabled'}}
 */
function validate(code) {
  const p = typeof code === 'string' ? get(code) : null;
  if (!p) return { ok: false, reason: 'unknown_profession' };
  if (!p.enabled) return { ok: false, reason: 'profession_disabled' };
  return { ok: true, profession: p };
}

/** Test only: resets the registry to empty. */
function _reset() {
  _professions.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial catalog (§4 of the professions briefing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The thirteen planned professions. Miner is the first concrete gameplay,
 * on top of the Resource Node Framework; the rest remain catalog-only.
 *
 * `guard` deserves the note §11 of the briefing asked for: this is an occupation/RP
 * LABEL, not the guard's authority. What an IC guard may
 * do — search, arrest, fine — is still decided by `governance-service.js`
 * (factions and posts), and this catalog grants none of those powers. A
 * character can have `profession = 'guard'` with no post at all in `governance`, and
 * vice versa; the two do not talk to each other in this phase, on purpose. See
 * `docs/gameplay/PROFESSION_FRAMEWORK.md` §"Guard × governance".
 *
 * @type {ReadonlyArray<{code:string,label:string,category:string,description?:string,gameplayImplemented?:boolean}>}
 */
const BUILTIN_PROFESSIONS = Object.freeze([
  { code: 'miner', label: 'Miner', category: 'gathering', gameplayImplemented: true },
  { code: 'lumberjack', label: 'Lumberjack', category: 'gathering' },
  { code: 'hunter', label: 'Hunter', category: 'gathering' },
  { code: 'farmer', label: 'Farmer', category: 'gathering' },
  { code: 'smelter', label: 'Smelter', category: 'crafting' },
  { code: 'blacksmith', label: 'Blacksmith', category: 'crafting' },
  { code: 'tanner', label: 'Tanner', category: 'crafting' },
  { code: 'enchanter', label: 'Enchanter', category: 'crafting' },
  { code: 'cook', label: 'Cook', category: 'crafting' },
  { code: 'stablehand', label: 'Stablehand', category: 'service' },
  { code: 'innkeeper', label: 'Innkeeper', category: 'service' },
  { code: 'courier', label: 'Courier', category: 'service' },
  {
    code: 'guard',
    label: 'Guard',
    category: 'institutional',
    description: 'Occupation/RP. NOT the guard authority — that lives in governance-service.js.'
  }
]);

/** Registers all thirteen, skipping any already present (idempotent, for reload/tests). */
function registerBuiltins() {
  for (const p of BUILTIN_PROFESSIONS) {
    if (!_professions.has(p.code)) {
      register({ ...p, enabled: true, gameplayImplemented: !!p.gameplayImplemented });
    }
  }
}

registerBuiltins();

module.exports = {
  CATEGORIES,
  CODE_SHAPE,
  BUILTIN_PROFESSIONS,
  register,
  registerBuiltins,
  get,
  list,
  isRegistered,
  isEnabled,
  isGameplayImplemented,
  validate,
  _reset
};
