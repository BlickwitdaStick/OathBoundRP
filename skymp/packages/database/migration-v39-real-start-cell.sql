-- =============================================================================
-- Migration v39 - Start, respawn and prison point at cells that exist
-- Apply after migration-v38-character-cell-desc.sql.
--
-- '162e2:Skyrim.esm' was believed to be The Bannered Mare. In Skyrim.esm the
-- record 0x162e2 is not a cell at all: it is an object placed in the Blue
-- Palace. Every character was teleported into that non-cell at login, SkyMP
-- then rejected all of the client's movement, so the server kept everyone at
-- 35, -165, -189: no NPCs were ever streamed to them and no position was
-- ever saved.
--
-- The Bannered Mare is CELL 0x1605e (WhiterunBanneredMare); -71, -86, 70 is its
-- centre marker. Characters still on the old non-cell are moved there. The old
-- prison default goes to WhiterunJail02 (CELL 0x580a2).
-- =============================================================================
USE `skymp_rp`;

UPDATE `characters`
   SET `cell_id` = '1605e:Skyrim.esm', `pos_x` = -71, `pos_y` = -86, `pos_z` = 70, `angle_z` = 178
 WHERE LOWER(`cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2');

ALTER TABLE `characters`
  ALTER COLUMN `cell_id` SET DEFAULT '1605e:Skyrim.esm',
  ALTER COLUMN `pos_x` SET DEFAULT -71,
  ALTER COLUMN `pos_y` SET DEFAULT -86,
  ALTER COLUMN `pos_z` SET DEFAULT 70,
  ALTER COLUMN `angle_z` SET DEFAULT 178;

UPDATE `prison_records`
   SET `cell_id` = '580a2:Skyrim.esm'
 WHERE LOWER(`cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2');

ALTER TABLE `prison_records`
  ALTER COLUMN `cell_id` SET DEFAULT '580a2:Skyrim.esm';

UPDATE `cities`
   SET `prison_cell_id` = '580a2:Skyrim.esm', `prison_pos_x` = 2995, `prison_pos_y` = 1002, `prison_pos_z` = 7220
 WHERE LOWER(`prison_cell_id`) IN ('162e2:skyrim.esm', '0x162e2', '162e2');
