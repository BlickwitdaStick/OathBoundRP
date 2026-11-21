-- =============================================================================
-- Migration v38 - Character cells stored as a full FormDesc ("id:plugin")
-- Apply after migration-v37-inventory-pending-delivery.sql.
--
-- characters.cell_id defaulted to '0x162e2' (The Bannered Mare). SkyMP reads a
-- cell with no ":plugin" as a server-generated id (0xff000000 + id), a cell
-- that does not exist. The login teleport put every character there, SkyMP
-- then rejected all client movement, and positions were never saved.
-- core/position-persistence.js now resolves the cell before the teleport; this
-- fixes the stored rows and the column default so the data says the same.
-- =============================================================================
USE `skymp_rp`;

UPDATE `characters`
   SET `cell_id` = '162e2:Skyrim.esm'
 WHERE `cell_id` IN ('0x162e2', '0x162E2', '162e2', '162E2');

ALTER TABLE `characters`
  ALTER COLUMN `cell_id` SET DEFAULT '162e2:Skyrim.esm';
