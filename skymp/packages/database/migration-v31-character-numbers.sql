-- =============================================================================
-- Migration v31 - Character numbers (#1..#5000)
-- Apply after migration-v30-account-keybinds.sql.
--
-- A short, unique number per living character, used by chat commands instead
-- of the SkyMP actorId (`/tp 12` instead of `/tp ff000a3c`). Assigned at login
-- to the lowest free number (gamemode/core/character-numbers.js) and set back
-- to NULL when the character is retired, so numbers are reused. NULL = not
-- assigned yet. Backfills approved characters in id order.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `characters`
  ADD COLUMN IF NOT EXISTS `char_number` SMALLINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Character number #1..#5000 used by chat commands; NULL until assigned or after retirement'
    AFTER `last_name`;

ALTER TABLE `characters`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_characters_char_number` (`char_number`);

SET @n := (SELECT COALESCE(MAX(`char_number`), 0) FROM `characters`);
UPDATE `characters`
  SET `char_number` = (@n := @n + 1)
  WHERE `status` = 'approved' AND `char_number` IS NULL
  ORDER BY `id`;
