/**
 * core/inventory-owner.js
 *
 * The vocabulary of "who owns this item".
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Until 2026-08-13 the server had **one** notion of an item owner: a character.
 * `core/transaction-service.js` only accepts `characterId`, and the
 * `inventory_transactions` ledger had `character_id INT NOT NULL`.
 *
 * Every time an item had to go somewhere else — a chest, a stall, a recipe —
 * whoever needed that wrote the other side by hand, outside the transaction. Three
 * independent implementations, with the same shape of defect that was already wiped out
 * twice in this project (`economy-service.transfer` and the pre-Phase-3
 * `craftItem`). See `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §2 to §5.
 *
 * This file is the cheap half of the fix: naming the owner. The expensive half is
 * `core/inventory-service.js`, which moves items between two owners in a single transaction.
 *
 * ─── What this file deliberately does NOT do ────────────────────────────────
 *
 * It does not touch `mp`, does not open the DB, does not know whether the owner exists. It is a pure function over
 * strings and numbers, for the same reason `core/interaction-registry.js` and
 * `core/soul.js` are: the part that can be proven outside the server lives where it
 * can be proven. Existence is checked by the storage adapter, inside
 * the transaction, where the answer is still valid when it gets used.
 */

/**
 * The seven owner types.
 *
 * **Three have a storage adapter today** (`character`, `container`,
 * `system`); the other four are reserved vocabulary, and a transfer
 * against them fails **closed and by name** in `inventory-service`.
 *
 * It is the same criterion as the Interaction Framework's `TARGET_TYPES`, for the same
 * reason: writing an adapter for `corpse` today would mean writing against a table
 * that does not exist and a consumer that does not exist. A closed vocabulary with a
 * registration point (`inventoryService.registerAdapter`) is extension; four
 * guessed adapters are worse than none, because they look finished.
 *
 * - `CHARACTER` — the character's persistent inventory (`character_inventory`).
 * - `CONTAINER` — a registered chest (`container_inventory`, keyed by `containers.id`).
 * - `PROPERTY`  — reserved. Today a property **is** a container
 *                 (`properties.container_id`); it becomes its own type when it has
 *                 stock that does not go through a chest.
 * - `FACTION`   — reserved. There is no item-holdings table for factions;
 *                 `factions.treasury` is gold, and the ADR for those holdings was not
 *                 written (see `PARKED_SERVICES_DECISION.md` §7.6).
 * - `CORPSE`    — reserved. `corpse-probe.js` observes corpses, it does not hold items.
 * - `MARKET`    — reserved. `market_stall_items` **is not** a stack: it carries
 *                 price, label and status per listing. Forcing it into this vocabulary
 *                 would erase the difference between stock and offer.
 * - `SYSTEM`    — the void. An item coming in comes from the world (craft, gathering, staff);
 *                 an item going out is destroyed (confiscation, consumption). It has no
 *                 storage **on purpose** — see §3 below.
 */
const OWNER_TYPES = Object.freeze({
  CHARACTER: 'character',
  CONTAINER: 'container',
  PROPERTY: 'property',
  FACTION: 'faction',
  CORPSE: 'corpse',
  MARKET: 'market',
  SYSTEM: 'system'
});

/** @type {Set<string>} */
const VALID_OWNER_TYPES = new Set(Object.values(OWNER_TYPES));

/**
 * Source/destination labels accepted for the `SYSTEM` owner.
 *
 * ─── Why `system` is a closed list ──────────────────────────────────────────
 *
 * `transfer({ from: system(...), to: character(...) })` **creates an item**. It is the same
 * power `transactionService.giveItem` already had, so nothing new is
 * granted — but there the power was hidden behind a name that looked
 * harmless, and here it is written in the signature.
 *
 * The closed list does two things. First, a new `ref` is an economy
 * decision that goes through code review, not a string typed in the middle of
 * a module. Second, it makes the question *"which paths create items on this
 * server?"* answerable by reading, which is exactly the question that
 * audit §2 could not answer.
 */
const SYSTEM_SOURCES = Object.freeze({
  /** Recipe output. Counterpart: the consumption of the ingredients. */
  CRAFT: 'craft',
  /** Consumption of an ingredient/resource that stops existing. */
  CONSUME: 'consume',
  /** Gathering in the world (wood, ore, fishing). */
  GATHER: 'gather',
  /** Staff creating or deleting an item, always audited. */
  STAFF: 'staff',
  /** Destruction by game rule (contraband confiscation). */
  DESTROY: 'destroy',
  /** Test and seed data. Must never show up in production. */
  SEED: 'seed'
});

/** @type {Set<string>} */
const VALID_SYSTEM_SOURCES = new Set(Object.values(SYSTEM_SOURCES));

/**
 * @typedef {object} InventoryOwner
 * @property {string} type        one of `OWNER_TYPES`
 * @property {string} ref         identifier within the type, **always a string**
 * @property {number|null} characterId  set only when `type === 'character'`
 * @property {number|null} actorId      SkyMP actor, when known — only for projecting onto the client
 * @property {string} label       short text for logs and audits
 */

/**
 * A `ref` is always a string in the DB (`owner_ref VARCHAR(64)`), because not every
 * owner type has a numeric id. Here the conversion happens in a single place.
 *
 * Rejects `""`, `null`, `undefined`, `NaN`, `Infinity` and anything over
 * 64 characters — the column size. Silently truncating would make two distinct
 * owners become the same `owner_ref`, which is the worst way to get this wrong.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeRef(raw) {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    return String(raw);
  }
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (!clean || clean.length > 64) return null;
  return clean;
}

/**
 * Builds an owner, validating the type and `ref`.
 *
 * @param {string} type
 * @param {unknown} ref
 * @param {{actorId?: number|null, label?: string}} [opts]
 * @returns {InventoryOwner}
 * @throws when the type is unknown or the `ref` is invalid
 */
function owner(type, ref, opts = {}) {
  if (!VALID_OWNER_TYPES.has(type)) {
    throw new Error(
      `[inventory-owner] unknown owner type: ${JSON.stringify(type)}. ` +
      `Valid: ${[...VALID_OWNER_TYPES].join(', ')}`
    );
  }

  const normalized = normalizeRef(ref);
  if (normalized === null) {
    throw new Error(`[inventory-owner] '${type}': invalid ref ${JSON.stringify(ref)}`);
  }

  if (type === OWNER_TYPES.SYSTEM && !VALID_SYSTEM_SOURCES.has(normalized)) {
    throw new Error(
      `[inventory-owner] unknown system source: '${normalized}'. ` +
      `Valid: ${[...VALID_SYSTEM_SOURCES].join(', ')}. ` +
      `Creating items under a new label is an economy decision, not a module one.`
    );
  }

  const actorId = Number.isSafeInteger(opts.actorId) && Number(opts.actorId) > 0
    ? Number(opts.actorId)
    : null;

  return Object.freeze({
    type,
    ref: normalized,
    characterId: type === OWNER_TYPES.CHARACTER ? Number(normalized) : null,
    actorId,
    label: opts.label ? String(opts.label).slice(0, 96) : `${type}:${normalized}`
  });
}

/**
 * The owner is a character.
 *
 * `actorId` is **optional and never authoritative**: it only exists to project the
 * change onto the client after the commit. An offline character transfers items the
 * same way — which is what makes it possible to return stall stock to someone who is not
 * connected, something `packStall` cannot do today.
 *
 * @param {number} characterId
 * @param {number|null} [actorId]
 */
function character(characterId, actorId = null) {
  return owner(OWNER_TYPES.CHARACTER, characterId, { actorId, label: `char:${characterId}` });
}

/**
 * The owner is a registered chest. `ref` is `containers.id`, **not** the `object_id`
 * (formDesc): the formDesc is the address in the world and can be repointed; the id is the
 * chest's identity.
 *
 * @param {number} containerId
 * @param {string} [label]
 */
function container(containerId, label) {
  return owner(OWNER_TYPES.CONTAINER, containerId, { label: label || `bau:${containerId}` });
}

/**
 * The owner is the void: the item is born here or dies here.
 * @param {string} source one of `SYSTEM_SOURCES`
 */
function system(source) {
  return owner(OWNER_TYPES.SYSTEM, source, { label: `sistema:${source}` });
}

/**
 * Stable key for the owner, for ordered locking, logging and deduplication.
 * @param {InventoryOwner} o
 * @returns {string}
 */
function key(o) {
  return `${o.type}:${o.ref}`;
}

/**
 * Are two owners the same?
 *
 * Used to refuse a transfer from someone to themselves — which is not a harmless
 * error: it would produce two ledger rows that cancel out and, on a path
 * with `FOR UPDATE`, could deadlock against its own transaction.
 *
 * @param {InventoryOwner} a
 * @param {InventoryOwner} b
 */
function isSame(a, b) {
  return Boolean(a && b && a.type === b.type && a.ref === b.ref);
}

/**
 * `system` holds nothing. It lets `inventory-service` know that it needs
 * no storage adapter and no lock for this end.
 * @param {InventoryOwner} o
 */
function isVoid(o) {
  return Boolean(o) && o.type === OWNER_TYPES.SYSTEM;
}

module.exports = {
  OWNER_TYPES,
  SYSTEM_SOURCES,
  owner,
  character,
  container,
  system,
  key,
  isSame,
  isVoid,
  normalizeRef
};
