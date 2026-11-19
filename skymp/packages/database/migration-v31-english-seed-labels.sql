-- =============================================================================
-- Migration v31 - English labels for player-facing seed data
-- Apply after migration-v29-public-work.sql (v30 is reserved for
-- migration-v30-account-keybinds.sql, which may land separately; this
-- migration does not depend on it).
--
-- The project was originally written in Portuguese. Already-applied
-- migrations are never edited, so the few player-facing strings that were
-- stored as data are renamed here instead:
--
--   * crafting recipes 1001/1002 from seed-forging.sql (shown in the crafting
--     UI). seed-forging.sql itself now inserts the English names; this only
--     fixes databases that were seeded before.
--   * the default name of a new row in `horses` ('Cavalo' -> 'Horse'), and
--     rows that still carry that untouched default.
--   * the automatic note written by migration-v2 on staff_roles rows that
--     were migrated from vip_level (staff-facing, but still prose).
--
-- Every UPDATE matches the exact old Portuguese value, so a label that staff
-- or a player already changed by hand is left alone, and running this twice
-- is harmless. Stored keys and enum values the code compares against are NOT
-- touched here.
-- =============================================================================

USE `skymp_rp`;

UPDATE `crafting_recipes` SET `name` = 'Smelt: Iron Armor'
 WHERE `id` = 1001 AND `name` = 'Derreter: Armadura de Ferro';

UPDATE `crafting_recipes` SET `name` = 'Smelt: Steel Sword'
 WHERE `id` = 1002 AND `name` = 'Derreter: Espada de Aço';

ALTER TABLE `horses` ALTER COLUMN `name` SET DEFAULT 'Horse';

UPDATE `horses` SET `name` = 'Horse' WHERE `name` = 'Cavalo';

UPDATE `staff_roles`
   SET `notes` = REPLACE(REPLACE(`notes`, 'Migrado automaticamente de vip_level=', 'Automatically migrated from vip_level='), ' em ', ' on ')
 WHERE `notes` LIKE 'Migrado automaticamente de vip_level=%';

-- =============================================================================
-- END OF MIGRATION v31
-- =============================================================================
