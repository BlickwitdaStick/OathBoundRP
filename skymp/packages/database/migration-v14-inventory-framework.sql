-- =============================================================================
-- Migration v14 - Inventory Framework: generic owner in the ledger
--
-- Apply after migration-v13-market-stall-idempotency.sql.
--
-- Motivation: docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md §2 and §8.
--
-- The `inventory_transactions` ledger could only talk about characters
-- (`character_id INT NOT NULL` with FK). An item that went into a container, stall or
-- recipe only recorded the character leg — the other end had no way to be
-- named, and the sum of the server's deltas did not match anything.
--
-- This migration does NOT move inventory data. `character_inventory` and
-- `container_inventory` stay where they are, with the same shape. What changes is
-- (a) the ledger now names both sides of every movement and (b) the two
-- stock tables get the unique key that declares the invariant the
-- code already assumed.
--
-- ⚠️ `MODIFY COLUMN` is not recognized by scripts/check-schema-drift.js — it
-- understands CREATE TABLE, ADD COLUMN, ADD INDEX and CREATE INDEX. The
-- nullability change of `character_id` below does NOT show up as drift if someone
-- forgets to apply this migration; the symptom will be a ledger INSERT with
-- `character_id = NULL` failing at runtime. Check by hand:
--     SHOW COLUMNS FROM inventory_transactions LIKE 'character_id';
-- =============================================================================
USE `skymp_rp`;

-- -----------------------------------------------------------------------------
-- 1. Consolidate duplicates before declaring the unique key
--
-- ⚠️ Only `container_inventory`. `character_inventory` **already has** the unique key
-- `uq_char_inventory_item` (`character_id`, `base_id`) since
-- migration-v7-indexes.sql, with the right comment for the right reason: it
-- "guards against two rows for the same item on the same character, which is
-- the state transaction-service's `FOR UPDATE` assumes does not exist".
--
-- The chest was left out of that round because `container_inventory` had no
-- active write path — and it still has none, but it now has an API.
--
-- If the invariant always held, this block touches nothing. If any duplicate
-- row exists (manual import, a write outside transaction-service), the
-- consolidation SUMS the counts instead of picking one — losing a player's
-- stock in a migration is worse than the duplicate we are fixing.
-- -----------------------------------------------------------------------------
CREATE TEMPORARY TABLE `_coi_dupes` AS
  SELECT MIN(`id`) AS `keep_id`, `container_id`, `base_id`, SUM(`count`) AS `total`
    FROM `container_inventory`
   GROUP BY `container_id`, `base_id`
  HAVING COUNT(*) > 1;

UPDATE `container_inventory` coi
  JOIN `_coi_dupes` d ON coi.`id` = d.`keep_id`
   SET coi.`count` = d.`total`;

DELETE coi FROM `container_inventory` coi
  JOIN `_coi_dupes` d
    ON d.`container_id` = coi.`container_id`
   AND d.`base_id` = coi.`base_id`
   AND coi.`id` <> d.`keep_id`;

DROP TEMPORARY TABLE `_coi_dupes`;

-- -----------------------------------------------------------------------------
-- 2. The invariant becomes a database rule — for the chest too
--
-- Audit §8: with the UNIQUE, a second row for the same (owner, item) is an
-- INSERT error instead of invisible stock — `applyStackDelta` would read
-- `rows[0]` and ignore the rest.
-- -----------------------------------------------------------------------------
ALTER TABLE `container_inventory`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_container_inventory_owner_item` (`container_id`, `base_id`);

-- -----------------------------------------------------------------------------
-- 3. The ledger now names both sides
--
-- `owner_type` / `owner_ref` : who owns this leg of the movement.
-- `counterparty_*`           : where the other leg went to (or came from).
-- `transfer_id`              : both legs of a transfer share
--                              this UUID. That is what lets you rebuild "this item
--                              left X and entered Y" with a single query.
--
-- `character_id` stays filled in when the owner is a character — no existing
-- query changes behavior, and `idx_inv_tx_char_date` keeps serving the
-- player's statement. It is NULL when the owner is a container, stall or the
-- system, which is why the column stops being NOT NULL.
-- -----------------------------------------------------------------------------
ALTER TABLE `inventory_transactions`
  MODIFY COLUMN `character_id` INT NULL
    COMMENT 'Set when owner_type = character; NULL for the other owners';

ALTER TABLE `inventory_transactions`
  ADD COLUMN IF NOT EXISTS `owner_type` VARCHAR(16) NOT NULL DEFAULT 'character'
    COMMENT 'character, container, property, faction, corpse, market, system'
    AFTER `character_id`,
  ADD COLUMN IF NOT EXISTS `owner_ref` VARCHAR(64) NOT NULL DEFAULT '0'
    COMMENT 'Owner identifier within the type (e.g. characters.id, containers.id)'
    AFTER `owner_type`,
  ADD COLUMN IF NOT EXISTS `counterparty_type` VARCHAR(16) DEFAULT NULL
    COMMENT 'Owner type on the other side of the transfer'
    AFTER `owner_ref`,
  ADD COLUMN IF NOT EXISTS `counterparty_ref` VARCHAR(64) DEFAULT NULL
    COMMENT 'Owner identifier on the other side'
    AFTER `counterparty_type`,
  ADD COLUMN IF NOT EXISTS `transfer_id` CHAR(36) DEFAULT NULL
    COMMENT 'UUID shared by both legs of the same transfer'
    AFTER `counterparty_ref`,
  ADD INDEX IF NOT EXISTS `idx_inv_tx_owner_date` (`owner_type`, `owner_ref`, `created_at`),
  ADD INDEX IF NOT EXISTS `idx_inv_tx_transfer` (`transfer_id`);

-- -----------------------------------------------------------------------------
-- 4. Backfill of already-recorded movements
--
-- Everything that exists today was recorded by a path that only knew how to talk about
-- characters, so `owner_type = 'character'` and `owner_ref = character_id` is the
-- correct reading of the past — not an assumption. `counterparty_*` stays NULL on
-- purpose: that information was never recorded, and inventing it now would be
-- worse than its absence.
-- -----------------------------------------------------------------------------
UPDATE `inventory_transactions`
   SET `owner_ref` = CAST(`character_id` AS CHAR)
 WHERE `owner_type` = 'character'
   AND `owner_ref` = '0'
   AND `character_id` IS NOT NULL;

-- =============================================================================
-- END OF MIGRATION v14
-- =============================================================================
