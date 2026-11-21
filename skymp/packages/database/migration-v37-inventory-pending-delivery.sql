-- =============================================================================
-- Migration v37 - Items waiting to reach a character's game inventory
-- Apply after migration-v36-skills-progression.sql.
--
-- SkyMP saves every character's real inventory itself (world/changeForms).
-- The login sync used to AddItem the whole `character_inventory` on every
-- login, on top of that saved inventory, so anything ever given by the server
-- (staff give, jobs, trade) came back after it was dropped, sold, eaten or
-- read (spell tomes) - once per login.
--
-- Now the login sync delivers only what never reached the game: items given
-- while the character was offline (e.g. an expired stall returning its goods)
-- or whose AddItem failed. One row per character and item; the row is removed
-- when the item is delivered. Existing `character_inventory` rows are NOT
-- copied here: they were delivered when they were given.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `character_inventory_pending` (
  `character_id` INT NOT NULL,
  `base_id`      INT NOT NULL COMMENT 'FormID nativo do Skyrim (Decimal)',
  `count`        INT NOT NULL DEFAULT 0 COMMENT 'How many still have to be put in the game inventory at login',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`character_id`, `base_id`),
  CONSTRAINT `fk_inventory_pending_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
