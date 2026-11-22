-- v23 — crafting_recipes: profession/rank gate
--
-- Originally implemented as v20 on the `feat/crafting-profession-integration` branch
-- (2026-08-20), orphaned since then. `main` already had v20 (Depot) and v21/v22
-- (Crime/Provenance) when this work was brought in on 2026-08-22 — only the
-- numbering changed (v20 -> v23) to avoid a collision; content identical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why this goes in, and why it is not `requires_perk` again
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `crafting_recipes.requires_perk` is the field Phase 0 found being read in
-- `listRecipes` and NEVER compared with anything — a validation that the service
-- header claimed existed and did not (see the header of
-- crafting-service.js and docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md §11).
-- This migration does not repeat the mistake: `required_profession`/`required_rank` are
-- checked inside `crafting-service.craftItem()` before any
-- consumption, with the same design `resource_nodes.required_profession` already uses
-- against `profession-service.js` (see migration-v19-resource-nodes.sql).
--
-- `required_perk` remains unused — touching it is out of scope for this migration,
-- which only documents that the new (actually checked) pattern is this one, not that.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why the column is per RECIPE, not per `station_type`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two recipes at the same forge can require different professions (a
-- simple horseshoe vs. an elven sword), and `alchemy_lab` has no matching
-- profession in the catalog today (core/profession-registry.js has no
-- `alchemist`) — so NULL per recipe, and not a fixed station→profession map
-- in code, is what leaves `alchemy_lab` ungated without needing an exception.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

ALTER TABLE `crafting_recipes`
  ADD COLUMN IF NOT EXISTS `required_profession` VARCHAR(32) DEFAULT NULL
    COMMENT 'code from core/profession-registry.js, or NULL for an open recipe',
  ADD COLUMN IF NOT EXISTS `required_rank` TINYINT UNSIGNED DEFAULT NULL;
