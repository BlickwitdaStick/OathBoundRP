-- =============================================================================
-- Migration v39 - Start, respawn and prison point at cells that exist
-- Apply after migration-v38-character-cell-desc.sql. Safe to run again.
--
-- '162e2:Skyrim.esm' was believed to be the start inn. In Skyrim.esm the
-- record 0x162e2 is not a cell at all: it is an object placed in the Blue
-- Palace. Every character was teleported into that non-cell at login, SkyMP
-- then rejected all of the client's movement, so the server kept everyone at
-- 35, -165, -189: no NPCs were ever streamed to them and no position was
-- ever saved.
--
-- The start is the Sleeping Giant Inn, Riverwood: CELL 0x133c6, at its
-- RiverwoodInnCenterMarker (-977, 9). Characters still on the old non-cell (or
-- on the Bannered Mare start an earlier draft of this migration used) move
-- there. The old prison default goes to WhiterunJail02 (CELL 0x580a2).
-- =============================================================================
USE `skymp_rp`;

UPDATE `characters`
   SET `cell_id` = '133c6:Skyrim.esm', `pos_x` = -977, `pos_y` = 9, `pos_z` = 5, `angle_z` = 137
 WHERE LOWER(`cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2')
    OR (LOWER(`cell_id`) = '1605e:skyrim.esm' AND `pos_x` = -71 AND `pos_y` = -86);

ALTER TABLE `characters`
  ALTER COLUMN `cell_id` SET DEFAULT '133c6:Skyrim.esm',
  ALTER COLUMN `pos_x` SET DEFAULT -977,
  ALTER COLUMN `pos_y` SET DEFAULT 9,
  ALTER COLUMN `pos_z` SET DEFAULT 5,
  ALTER COLUMN `angle_z` SET DEFAULT 137;

UPDATE `prison_records`
   SET `cell_id` = '580a2:Skyrim.esm'
 WHERE LOWER(`cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2');

ALTER TABLE `prison_records`
  ALTER COLUMN `cell_id` SET DEFAULT '580a2:Skyrim.esm';

UPDATE `cities`
   SET `prison_cell_id` = '580a2:Skyrim.esm', `prison_pos_x` = 2995, `prison_pos_y` = 1002, `prison_pos_z` = 7220
 WHERE LOWER(`prison_cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2');
