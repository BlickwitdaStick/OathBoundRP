/**
 * core/interaction-registry.js
 *
 * The server's catalog of contextual interactions. A module declares here
 * what can be done to a target; `core/interaction-service.js` decides, on
 * every request, whether that holds **right now**.
 *
 * ─── Why this exists, and what it replaces ──────────────────────────────────
 *
 * The interaction menu already existed inside `governance-service.js`
 * (`getInteractionActions` / `handleInteractionAction`), and its **flow**
 * was right: the server builds the list, the client picks, the server
 * revalidates before executing. What was wrong was where it lived.
 *
 * For a stall to show up in the menu, governance had to
 * `require('./market-stalls-service')` by a fixed name, inside a domain
 * function — and `market-stalls` already declares `dependencies: ['governance']` in the
 * registry, so the arrow pointed both ways. The action vocabulary
 * was the regex `/^(guard|stall|npc)\.[a-z_]+$/` in governance's core: three
 * namespaces, and no way to add a fourth other than editing that
 * file. Details in `docs/research/CORE_FRAMEWORK_AUDIT.md` §6.
 *
 * Here the arrow is reversed. Whoever has an action to offer **registers** it; nobody
 * looks anybody up. `governance-service` no longer knows `market-stalls`, and a
 * future module (`medical`, `carry`, `crafting`) shows up in the menu without
 * a single line of change in the core. It is §23 of the request, and the reason there is no
 * Service Locator in this project — see
 * `docs/technical/ADR_002_INTERACTION_FRAMEWORK.md` §4.
 *
 * ─── What this file deliberately does NOT do ────────────────────────────────
 *
 * It does not touch `mp`, does not open the DB, knows nothing about actors, characters, distance or
 * permissions. It stores descriptors and rejects malformed ones. Every decision about
 * a concrete request belongs to `interaction-service`, which is where the trust
 * boundary lives. Same reason `core/soul.js` is a pure function:
 * the part that can be proven outside the server lives where it can be proven.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Target types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an interaction can target.
 *
 * **Only `PLAYER` has a resolver implemented today** (`core/interaction-targets.js`),
 * because only it has a consumer. The other six are here as reserved
 * vocabulary: registering an interaction against one of them is accepted, and the request fails
 * in the resolver with "unsupported target type" — a closed, named and
 * visible failure, instead of an `undefined` flowing through the pipeline.
 *
 * The criterion is the same the `module-registry` header used on 2026-08-06
 * to **not** build game-event distribution: one live key and six
 * dead ones would be premature abstraction; a closed vocabulary with a registrable
 * resolver (`interactionTargets.registerResolver`) is an extension point. The
 * day `container` has an owner, it registers its resolver and nothing here
 * changes.
 */
const TARGET_TYPES = Object.freeze({
  PLAYER: 'player',
  NPC: 'npc',
  OBJECT: 'object',
  CONTAINER: 'container',
  DOOR: 'door',
  PROPERTY: 'property',
  WORLD_POINT: 'world_point',
  // Task 11 (Character Dashboard). The actor themselves — never out of range
  // of themselves, so whoever registers for this type does not declare `distance`
  // (the resolver does not expose `assertRange`, and without it `buildContext` skips the
  // distance check entirely).
  SELF: 'self'
});

/** @type {Set<string>} */
const VALID_TARGET_TYPES = new Set(Object.values(TARGET_TYPES));

/**
 * Audit classes. §20 of the request is explicit both ways: a critical
 * action produces a record, and the server does not produce millions of useless rows.
 *
 * - `TRACE`    — nothing is written. Queries, reads, opening wares.
 * - `GAMEPLAY` — written. An action that changes the world reversibly.
 * - `SECURITY` — written. An action by one player **on another** without consent.
 * - `ADMIN`    — written. Staff power.
 * - `ECONOMY`  — written. Moves gold or items.
 *
 * The default is `GAMEPLAY`: if you did not choose, it is written. Silence is opt-in.
 */
const AUDIT_LEVELS = Object.freeze({
  TRACE: 'TRACE',
  GAMEPLAY: 'GAMEPLAY',
  SECURITY: 'SECURITY',
  ADMIN: 'ADMIN',
  ECONOMY: 'ECONOMY'
});

/** @type {Set<string>} */
const VALID_AUDIT_LEVELS = new Set(Object.values(AUDIT_LEVELS));

/** `<module>.<action>`, lowercase. Replaces the regex of three fixed namespaces. */
const ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const MAX_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Declarative payload validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Types accepted in an interaction `schema`. Deliberately few: every new
 * type is a new way for a client payload to cross the boundary, and the
 * short list is what makes review possible.
 */
const FIELD_TYPES = new Set(['string', 'int', 'bool', 'enum', 'formid']);

/**
 * A positive integer written by whoever controls the client.
 *
 * Rejects `"1e3"`, `" 1"`, `"01"`, `1.5`, `Infinity` and `"0x10"` — the same
 * discipline as governance's `isStrictPositiveInteger`, which this function
 * replaces. `Number("1e3")` is 1000 and `parseInt(" 1")` is 1: both loose
 * forms would slip through a naive "can it be converted" validation.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function strictInteger(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : null;
  }
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A Skyrim FormID, written in hexadecimal with or without `0x`.
 *
 * Separate from `int` because the player types `0x0000000F` in the form and
 * `Number("0x0000000F")` is 15 — which works, but by accident: the same
 * conversion would accept `0b1010` and `0o17`. Here the shape is checked first.
 *
 * This validates **typing**, not existence: whether the FormID points to a real
 * item is a question for `core/espm.js`, which is what has the plugins loaded.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function strictFormId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
  const parsed = Number.parseInt(clean, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Checks a client payload against the `schema` declared on the interaction.
 *
 * Returns a **new** object, with only the declared fields, already converted —
 * never the original payload. That is the difference between validating and sanitizing: if
 * `execute` received the client's object, an extra field (`characterId`,
 * `price`, `allowed`) would travel along until someone, one day, read it.
 *
 * @param {Record<string, object>|undefined} schema
 * @param {unknown} payload
 * @returns {{ok: true, data: Record<string, unknown>}|{ok: false, reason: string}}
 */
function validatePayload(schema, payload) {
  if (!schema || Object.keys(schema).length === 0) return { ok: true, data: {} };

  if (payload !== undefined && payload !== null &&
    (typeof payload !== 'object' || Array.isArray(payload))) {
    return { ok: false, reason: 'Invalid action data.' };
  }
  const source = /** @type {Record<string, unknown>} */ (payload || {});
  /** @type {Record<string, unknown>} */
  const data = {};

  for (const [name, rawSpec] of Object.entries(schema)) {
    const spec = /** @type {any} */ (rawSpec);
    const present = Object.hasOwn(source, name) && source[name] !== undefined && source[name] !== '';

    if (!present) {
      if (spec.required) return { ok: false, reason: `Missing required field: ${name}.` };
      if (Object.hasOwn(spec, 'default')) data[name] = spec.default;
      continue;
    }

    const value = source[name];

    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') return { ok: false, reason: `Field ${name} must be text.` };
        const trimmed = value.trim();
        if (spec.min !== undefined && trimmed.length < spec.min) {
          return { ok: false, reason: `Field ${name} is too short.` };
        }
        // The cap exists on every text field, with or without a declared `max`: a
        // CEF payload with no limit is server memory controlled by whoever
        // is playing.
        const max = spec.max === undefined ? 240 : spec.max;
        if (trimmed.length > max) return { ok: false, reason: `Field ${name} is too long.` };
        data[name] = trimmed;
        break;
      }
      case 'int': {
        const parsed = strictInteger(value);
        if (parsed === null) return { ok: false, reason: `Field ${name} must be a whole number.` };
        if (spec.min !== undefined && parsed < spec.min) {
          return { ok: false, reason: `Field ${name} is below the minimum (${spec.min}).` };
        }
        if (spec.max !== undefined && parsed > spec.max) {
          return { ok: false, reason: `Field ${name} is above the maximum (${spec.max}).` };
        }
        data[name] = parsed;
        break;
      }
      case 'formid': {
        const parsed = strictFormId(value);
        if (parsed === null) return { ok: false, reason: `Field ${name} is not a valid FormID.` };
        data[name] = parsed;
        break;
      }
      case 'bool': {
        if (typeof value === 'boolean') { data[name] = value; break; }
        if (value === 'true' || value === 'false') { data[name] = value === 'true'; break; }
        return { ok: false, reason: `Field ${name} must be true or false.` };
      }
      case 'enum': {
        if (typeof value !== 'string' || !spec.values.includes(value)) {
          return { ok: false, reason: `Field ${name} has an invalid value.` };
        }
        data[name] = value;
        break;
      }
      default:
        // Only happens if `register` lets a new type through — which is why it
        // validates the schema at registration, and not here, with the player waiting.
        return { ok: false, reason: `Field ${name} has a type the server does not know.` };
    }
  }

  return { ok: true, data };
}

/**
 * Checks the `schema` at registration time, and not on the first click.
 *
 * A misspelled `type` in a descriptor is a programmer error, and the place
 * to find it is server boot — not the screen of a player trying to
 * pay a fine. Same discipline as `safe-zones.parseZones` and
 * `admin-service.hasPermission`: wrong configuration screams where it is read.
 *
 * @param {string} interactionId
 * @param {unknown} schema
 */
function assertValidSchema(interactionId, schema) {
  if (schema === undefined) return;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`[interaction-registry] '${interactionId}': schema must be an object`);
  }
  for (const [name, rawSpec] of Object.entries(schema)) {
    const spec = /** @type {any} */ (rawSpec);
    if (!spec || typeof spec !== 'object') {
      throw new Error(`[interaction-registry] '${interactionId}': field '${name}' has no specification`);
    }
    if (!FIELD_TYPES.has(spec.type)) {
      throw new Error(
        `[interaction-registry] '${interactionId}': field '${name}' has type '${spec.type}'. ` +
        `Valid: ${[...FIELD_TYPES].join(', ')}`
      );
    }
    if (spec.type === 'enum' && (!Array.isArray(spec.values) || spec.values.length === 0)) {
      throw new Error(`[interaction-registry] '${interactionId}': enum field '${name}' has no 'values'`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registro
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const _interactions = new Map();

/**
 * Registers an interaction.
 *
 * @param {object} descriptor
 * @param {string}   descriptor.id        - `<module>.<action>`, e.g. `law.search`
 * @param {string}   descriptor.module    - owning module (used on shutdown)
 * @param {string}   descriptor.target    - one of `TARGET_TYPES`
 * @param {string}   descriptor.label     - button text, already in its display language
 * @param {Function} descriptor.execute   - `async (ctx) => void`
 * @param {Function} [descriptor.canSee]     - `async (ctx) => boolean` — does it show up in the menu?
 * @param {Function} [descriptor.canExecute] - `async (ctx) => boolean|{allowed,reason}`
 * @param {string}   [descriptor.permission] - permission checked by the module's adapter
 * @param {number}   [descriptor.distance]   - maximum range in Skyrim units
 * @param {string}   [descriptor.policyAction] - action id in `core/action-policy.js`
 * @param {object}   [descriptor.schema]     - fields accepted in the payload
 * @param {string}   [descriptor.audit]      - one of `AUDIT_LEVELS` (default `GAMEPLAY`)
 * @param {boolean}  [descriptor.idempotent] - requires a `requestId` and deduplicates (§19)
 * @param {number}   [descriptor.order]      - menu ordering (lowest first)
 * @param {string}   [descriptor.section]    - menu grouping (default: the module)
 */
function register(descriptor) {
  const {
    id, module: moduleId, target, label,
    execute, canSee, canExecute,
    permission, distance, policyAction, schema,
    audit = AUDIT_LEVELS.GAMEPLAY,
    idempotent = false,
    order = 100,
    section
  } = descriptor || {};

  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH) {
    throw new Error(
      `[interaction-registry] invalid id: ${JSON.stringify(id)}. ` +
      `Expected '<module>.<action>' in lowercase, e.g. 'law.search'`
    );
  }
  // A duplicate is an error, not a warning. `command-registry` warns and overrides, and
  // that is defensible for a chat command — whoever types it sees the result
  // right away. Here the overridden action would keep **showing up in the menu with the same
  // label** and running another module's code. Two actions with the same id
  // is a programmer bug, and boot is where it should die.
  if (_interactions.has(id)) {
    const dono = _interactions.get(id).module;
    throw new Error(
      `[interaction-registry] '${id}' already registered by module '${dono}'. ` +
      `Duplicate ids would silently override the action.`
    );
  }
  if (typeof moduleId !== 'string' || !moduleId) {
    throw new Error(`[interaction-registry] '${id}': no 'module'`);
  }
  if (!VALID_TARGET_TYPES.has(target)) {
    throw new Error(
      `[interaction-registry] '${id}': unknown target '${target}'. ` +
      `Valid: ${[...VALID_TARGET_TYPES].join(', ')}`
    );
  }
  if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH) {
    throw new Error(`[interaction-registry] '${id}': invalid label`);
  }
  if (typeof execute !== 'function') {
    throw new Error(`[interaction-registry] '${id}': no execute function`);
  }
  for (const [nome, fn] of [['canSee', canSee], ['canExecute', canExecute]]) {
    if (fn !== undefined && typeof fn !== 'function') {
      throw new Error(`[interaction-registry] '${id}': ${nome} must be a function`);
    }
  }
  if (distance !== undefined && !(Number.isFinite(distance) && distance > 0)) {
    throw new Error(`[interaction-registry] '${id}': distance must be a positive number`);
  }
  if (!VALID_AUDIT_LEVELS.has(audit)) {
    throw new Error(
      `[interaction-registry] '${id}': unknown audit '${audit}'. ` +
      `Valid: ${[...VALID_AUDIT_LEVELS].join(', ')}`
    );
  }
  assertValidSchema(id, schema);

  _interactions.set(id, {
    id, module: moduleId, target, label,
    execute,
    canSee: canSee || null,
    canExecute: canExecute || null,
    permission: permission || null,
    distance: distance === undefined ? null : distance,
    policyAction: policyAction || null,
    schema: schema || null,
    audit,
    idempotent: Boolean(idempotent),
    order,
    section: section || moduleId
  });
}

/**
 * @param {string} id
 * @returns {object|undefined}
 */
function get(id) {
  return typeof id === 'string' ? _interactions.get(id) : undefined;
}

/**
 * Candidate interactions for a target type, already in menu order.
 *
 * "Candidates" and not "available": there is no actor, target or permission here. Filtering
 * by `canSee` is `interaction-service`'s job, with context at hand.
 *
 * @param {string} targetType
 * @returns {object[]}
 */
function listForTarget(targetType) {
  const found = [];
  for (const entry of _interactions.values()) {
    if (entry.target === targetType) found.push(entry);
  }
  return found.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/**
 * Removes everything a module registered.
 *
 * Called on the module's `shutdown`, for the same reason `module-registry`
 * removes commands: an action that stays in the menu after its module shuts down
 * runs against a service that never initialized.
 *
 * @param {string} moduleId
 * @returns {number} how many were removed
 */
function unregisterModule(moduleId) {
  let removed = 0;
  for (const [id, entry] of _interactions.entries()) {
    if (entry.module === moduleId) {
      _interactions.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Every registered interaction, for diagnostics and for staff. */
function list() {
  return Array.from(_interactions.values()).map(entry => ({
    id: entry.id,
    module: entry.module,
    target: entry.target,
    label: entry.label,
    permission: entry.permission,
    distance: entry.distance,
    audit: entry.audit,
    idempotent: entry.idempotent
  }));
}

/** Test only: resets the registry to empty between cases. */
function _reset() {
  _interactions.clear();
}

module.exports = {
  TARGET_TYPES,
  AUDIT_LEVELS,
  FIELD_TYPES,
  register,
  get,
  listForTarget,
  unregisterModule,
  list,
  validatePayload,
  strictInteger,
  strictFormId,
  _reset
};
