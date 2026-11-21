-- =============================================================================
-- Migration v34 - Gold in the inventory, tied to the server balance
-- Apply after migration-v33-holdstones-parcels.sql.
--
-- `characters.gold` stays the balance every server system reads and writes
-- (stalls, trade, depot, salaries, staff). Gold001 in the character's
-- inventory is now the same money, kept equal by core/economy-physical-sync.js:
-- gold looted, picked up or dropped in game changes the balance, and server
-- payments add or remove real gold in the inventory.
--
-- `gold_synced` is the amount both sides last agreed on. Each sync compares
-- the inventory and the balance against it, so changes on both sides since
-- then are added together instead of one overwriting the other. NULL = never
-- synced: the first sync counts both, so gold already in an inventory is
-- added to the balance and the balance is put into the inventory.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `characters`
  ADD COLUMN IF NOT EXISTS `gold_synced` INT NULL DEFAULT NULL
    COMMENT 'Gold amount the inventory and characters.gold last agreed on (core/economy-physical-sync.js); NULL = never synced'
    AFTER `gold`;
