/**
 * core/resource-node-registry.js
 *
 * The vocabulary of resource node types, and nothing else.
 *
 * ─── Why this is NOT a rich catalog, unlike profession-registry ─────────────
 *
 * `core/profession-registry.js` holds thirteen named entries because
 * "miner" and "lumberjack" have an identity of their own — label, category — that
 * repeats on every character who has it. A resource node does not: an iron vein and
 * a silver vein are the same TYPE (`ORE`) with a different configuration
 * (capacity, regeneration, item delivered), and that configuration lives in the
 * INSTANCE (`resource_nodes`, in `resource-node-service.js`), not in a
 * catalog of types.
 *
 * Creating a second catalog layer here — "iron vein", "silver
 * vein", each with a label and rules — would duplicate what the DB row already
 * stores, for the same reason `migration-v18-professions.sql` did not create a
 * `professions` table: a catalog with no extra degree of freedom is a mirror, not an
 * abstraction.
 *
 * What needs to be closed is only the CATEGORY (§7 of the professions briefing:
 * "ORE, TREE, HERB, CROP, FISHING") — closed because `resource-node-service.js`
 * decides behavior by it (today, only validation; in the future, maybe a sound
 * effect or animation per category), and a free-form category would meet the same
 * fate `details TEXT` already met in `audit_logs`: four spellings for the
 * same thing.
 */

'use strict';

/**
 * The five categories planned in the original briefing. A new category comes in
 * here, under review — it is the same design decision as `core/audit-event
 * .CATEGORIES` and `core/profession-registry.CATEGORIES`.
 */
const NODE_TYPES = Object.freeze({
  ORE: 'ORE',
  TREE: 'TREE',
  HERB: 'HERB',
  CROP: 'CROP',
  FISHING: 'FISHING'
});

/** @type {Set<string>} */
const VALID_NODE_TYPES = new Set(Object.values(NODE_TYPES));

/** @param {unknown} type */
function isValidType(type) {
  return typeof type === 'string' && VALID_NODE_TYPES.has(type);
}

module.exports = {
  NODE_TYPES,
  VALID_NODE_TYPES,
  isValidType
};
