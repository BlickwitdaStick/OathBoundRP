-- v27 — resource_nodes: the persistent state of the Resource Node Framework
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Scope of this migration
-- ═══════════════════════════════════════════════════════════════════════════
--
-- It creates ONLY `resource_nodes` — the instance of a node in the world (an ore
-- vein, a tree) and its state (current capacity, when it was
-- last updated). It does NOT create:
--
--   * a "node type" table — `type` is a VARCHAR closed in code
--     (core/resource-node-registry.NODE_TYPES), the same pattern as
--     `crafting_recipes.station_type` and `character_professions
--     .profession_code`: a closed catalog, validated in code, with no table of
--     its own, because nothing in this phase creates a new type at runtime;
--   * a gathering session / action token — that controls ONE gathering
--     ATTEMPT (distance, tool, animation), which belongs to the concrete profession
--     that consumes this framework (Miner etc.), not to the generic
--     framework;
--   * anything specific to Miner, Woodcutter or Hunter.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why capacity is not updated by a tick
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `last_updated_at` + `regen_per_hour` are the pair that lets us compute the
-- current capacity ON DEMAND (`elapsed_ms / 3600000 * regen_per_hour`,
-- rounded down, added to the stored capacity, capped at
-- `max_capacity`) instead of a job running every second per node — the same
-- choice `core/transaction-service.js` already avoids for gold ("regen" does not
-- even exist there) and that §26 of the professions briefing explicitly asked for
-- ("may store lastUpdatedAt and compute regeneration when the node is
-- queried"). Only `resource-node-service.consume()` WRITES the recomputed
-- capacity — a pure read writes nothing.
--
-- `regen_per_hour` is INTEGER, not FLOAT: the project already avoids floating point in
-- game counters (rank, xp, gold are all integers) for the same reason that
-- motivated `MAX_STACK_COUNT`/`MAX_GOLD` in `core/transaction-service.js` —
-- a rounding error in production is worse than the precision loss of "you cannot
-- regenerate half a unit per second".
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `required_profession`/`required_rank`: why these two go in and
-- `required_tool` does not
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 0 found in `crafting_recipes.requires_perk` a field that was read and
-- NEVER compared with anything — a validation the service header
-- claimed existed and did not. This framework does not repeat that:
-- `required_profession`/`required_rank` are actually checked inside
-- `resource-node-service.consume()`, against `profession-service.js`, because the
-- framework already has access to it.
--
-- `required_tool` does NOT go in: "the player has the pickaxe equipped" requires
-- querying `Actor.GetItemCount` — Papyrus, live, against the client — which is
-- exactly the kind of check that belongs to the concrete gameplay layer
-- (Miner), not to this generic framework. Adding the column now would be
-- the same mistake as `requires_perk`: a field nothing in this phase compares.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `resource_nodes` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,

  -- FormDesc of the world object: hex WITHOUT prefix, colon, file
  -- name (e.g. '162e2:Skyrim.esm') — the convention documented in the project
  -- CLAUDE.md. Unique because a world object can only be one node.
  `form_desc`             VARCHAR(64) NOT NULL COMMENT 'FormDesc of the world object, e.g. 4a2f0:Skyrim.esm',

  -- Category closed in code — core/resource-node-registry.NODE_TYPES.
  `type`                  VARCHAR(16) NOT NULL COMMENT 'ORE, TREE, HERB, CROP, FISHING',

  -- What this node yields per gathering, and how much.
  `resource_base_id`      INT NOT NULL COMMENT 'Native Skyrim FormID delivered via transaction-service.tx',
  `yield_per_action`      INT NOT NULL DEFAULT 1,

  -- Capacity: what the node has now (stored) and the ceiling (config).
  `max_capacity`          INT NOT NULL,
  `current_capacity`      INT NOT NULL,
  `regen_per_hour`        INT NOT NULL DEFAULT 0 COMMENT 'units regenerated per hour, computed on demand',
  `last_updated_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'last write of current_capacity - base of the regen calculation',

  -- Optional gate. NULL = any character may try (tool and distance
  -- checks, if any, belong to whoever consumes this framework).
  `required_profession`   VARCHAR(32) DEFAULT NULL COMMENT 'code from core/profession-registry.js, or NULL',
  `required_rank`         TINYINT UNSIGNED DEFAULT NULL,

  -- Admin switch — node out of rotation without deleting history.
  `enabled`               TINYINT(1) NOT NULL DEFAULT 1,

  `created_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY `uk_resource_node_form_desc` (`form_desc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
--
-- `idx_resource_nodes_type` — admin query ("how many ore
-- veins are there?"), cheap to have ready now.
-- `idx_resource_nodes_enabled` — the same, for "how many nodes are out of
-- rotation?".
--
-- No concurrency index here: `consume()` locks by `id`, the primary
-- key, which is indexed by construction.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `resource_nodes`
  ADD INDEX IF NOT EXISTS `idx_resource_nodes_type`    (`type`),
  ADD INDEX IF NOT EXISTS `idx_resource_nodes_enabled` (`enabled`);

-- Persistent cooldown per character and node. The composite key also serializes
-- two concurrent attempts by the same character on the same resource.
CREATE TABLE IF NOT EXISTS `resource_node_gathers` (
  `resource_node_id` INT NOT NULL,
  `character_id` INT NOT NULL,
  `last_gathered_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`resource_node_id`, `character_id`),
  CONSTRAINT `fk_resource_node_gather_node`
    FOREIGN KEY (`resource_node_id`) REFERENCES `resource_nodes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_resource_node_gather_character`
    FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
