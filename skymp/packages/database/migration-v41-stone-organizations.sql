-- =============================================================================
-- Migration v41 - Stones belong to organizations, not only to holds
-- Apply after migration-v40-survival-thirst.sql. Safe to run again.
--
-- A stone is the seat of an ORGANIZATION: a hold (Whiterun), a town
-- (Riverwood), a faction (the Imperial Legion), a thanedom, or a council
-- (staff meetings at High Hrothgar). Each organization has its own rank ladder, members and parcels;
-- a character can belong to several (citizen of Solitude AND Legion soldier).
-- Solitude can therefore have two stones: the Solitude stone and the Legion's.
--
-- `stone_orgs.hold_id` is where the organization sits (NULL = not tied to a
-- hold); it is location only and grants nothing. `parcels.hold_id` likewise
-- becomes "which hold the building is in" (nullable); `parcels.org_id` is who
-- controls it.
--
-- Each organization has its OWN activator in Oathbound_Holdstone.esp
-- (`base_id`, e.g. `801:Oathbound_Holdstone.esp` = "Whiterun Holdstone").
-- Every reference of that activator, placed in the Creation Kit, is that
-- organization's stone: nothing is bound per placed object any more. The list
-- lives in gamemode/data/holdstones.json; the gamemode fills `base_id`,
-- `name`, `kind` and `hold_id` from it on boot and gives new organizations
-- the default ladder of their kind.
--
-- Data from v33 is copied: every hold becomes an organization with the same id
-- (`whiterun`...), with its ranks (same ids, so parcels keep their minimum
-- rank) and members. v33's per-object stone bindings (`holdstones`) are not
-- carried over: stones are known by their activator now. The v33 tables
-- `holdstones`, `hold_ranks` and
-- `hold_members` are no longer read by the gamemode; they are left in place
-- (not dropped) so this migration loses nothing. They can be dropped by hand
-- once the new tables are confirmed on the live server.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `stone_orgs` (
  `id`         VARCHAR(32) NOT NULL PRIMARY KEY COMMENT 'Short key used in commands: whiterun, imperial_legion, high_hrothgar',
  `name`       VARCHAR(64) NOT NULL,
  `kind`       ENUM('hold', 'town', 'faction', 'thanedom', 'council') NOT NULL DEFAULT 'faction',
  `hold_id`    VARCHAR(32) NULL DEFAULT NULL COMMENT 'Hold where it sits; NULL = none. Location only, grants nothing',
  `base_id`    VARCHAR(64) NULL DEFAULT NULL COMMENT 'FormDesc of its stone activator (801:Oathbound_Holdstone.esp); NULL = no stone',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_stone_orgs_base` (`base_id`),
  CONSTRAINT `fk_stone_org_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stone_ranks` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `org_id`     VARCHAR(32) NOT NULL,
  `rank_key`   VARCHAR(32) NOT NULL,
  `name`       VARCHAR(64) NOT NULL,
  `position`   SMALLINT NOT NULL COMMENT 'Ladder order; higher = more authority',
  `is_leader`  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = sets ranks below their own and manages parcels',
  UNIQUE KEY `uq_stone_ranks_key` (`org_id`, `rank_key`),
  UNIQUE KEY `uq_stone_ranks_position` (`org_id`, `position`),
  CONSTRAINT `fk_stone_rank_org` FOREIGN KEY (`org_id`) REFERENCES `stone_orgs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stone_members` (
  `org_id`       VARCHAR(32) NOT NULL,
  `character_id` INT NOT NULL,
  `rank_id`      INT NOT NULL,
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`org_id`, `character_id`),
  CONSTRAINT `fk_stone_member_org`       FOREIGN KEY (`org_id`)       REFERENCES `stone_orgs` (`id`)  ON DELETE CASCADE,
  CONSTRAINT `fk_stone_member_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`)  ON DELETE CASCADE,
  CONSTRAINT `fk_stone_member_rank`      FOREIGN KEY (`rank_id`)      REFERENCES `stone_ranks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `stone_members`
  ADD INDEX IF NOT EXISTS `idx_stone_members_character` (`character_id`);

-- ── copy v33 data ─────────────────────────────────────────────────────────────
INSERT IGNORE INTO `stone_orgs` (`id`, `name`, `kind`, `hold_id`)
  SELECT `id`, `name`, 'hold', `id` FROM `holds`;

INSERT IGNORE INTO `stone_ranks` (`id`, `org_id`, `rank_key`, `name`, `position`, `is_leader`)
  SELECT `id`, `hold_id`, `rank_key`, `name`, `position`, `is_leader` FROM `hold_ranks`;

INSERT IGNORE INTO `stone_members` (`org_id`, `character_id`, `rank_id`)
  SELECT `hold_id`, `character_id`, `rank_id` FROM `hold_members`;

-- ── parcels: who controls it (org) vs where it is (hold) ─────────────────────
ALTER TABLE `parcels`
  ADD COLUMN IF NOT EXISTS `org_id` VARCHAR(32) NULL DEFAULT NULL
    COMMENT 'Organization that controls the parcel; ranks are checked in this organization' AFTER `id`;

UPDATE `parcels` SET `org_id` = `hold_id` WHERE `org_id` IS NULL;

ALTER TABLE `parcels`
  MODIFY COLUMN `hold_id` VARCHAR(32) NULL DEFAULT NULL COMMENT 'Hold the building is in; NULL = none. Location only';

ALTER TABLE `parcels`
  ADD INDEX IF NOT EXISTS `idx_parcels_org` (`org_id`);

ALTER TABLE `parcels` DROP FOREIGN KEY IF EXISTS `fk_parcel_min_rank`;
ALTER TABLE `parcels` DROP FOREIGN KEY IF EXISTS `fk_parcel_org`;
ALTER TABLE `parcels` DROP FOREIGN KEY IF EXISTS `fk_parcel_org_min_rank`;
ALTER TABLE `parcels`
  ADD CONSTRAINT `fk_parcel_org` FOREIGN KEY (`org_id`) REFERENCES `stone_orgs` (`id`) ON DELETE CASCADE;
ALTER TABLE `parcels`
  ADD CONSTRAINT `fk_parcel_org_min_rank` FOREIGN KEY (`min_rank_id`) REFERENCES `stone_ranks` (`id`) ON DELETE SET NULL;

-- Parcel names are unique per organization now (the Legion and the city can
-- both have a "Barracks" in Solitude).
-- v33's unique (hold_id, name) is replaced by a plain index of the same name,
-- in ONE statement: it backs the hold_id foreign key, so it cannot be dropped
-- alone, and check-schema-drift (which reads v33's CREATE TABLE) still finds it.
ALTER TABLE `parcels`
  DROP INDEX IF EXISTS `uq_parcels_hold_name`,
  ADD INDEX IF NOT EXISTS `uq_parcels_hold_name` (`hold_id`, `name`);
ALTER TABLE `parcels`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_parcels_org_name` (`org_id`, `name`);
