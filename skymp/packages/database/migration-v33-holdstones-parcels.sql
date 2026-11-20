-- =============================================================================
-- Migration v33 - Holdstones, hold ranks, parcels and door/container locks
-- Apply after migration-v31-character-numbers.sql (and v32, if present).
--
-- One holdstone per hold: a world object (FormDesc `hex:Plugin.esm`, never a
-- numeric FormID) that opens the hold menu. Each hold has an ordered rank
-- ladder (higher `position` = more authority; `is_leader` ranks run the hold).
-- A parcel is a set of doors and containers with an owner character and a
-- minimum rank; its objects open only for the owner, members of that hold at
-- or above the minimum rank, and staff. See gamemode/holdstone-service.js and
-- docs/gameplay/HOLDSTONES_AND_PARCELS.md.
--
-- Every table states COLLATE explicitly so `hold_id` matches `holds.id`
-- (same reason as migration-v20-depot-service.sql).
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `holdstones` (
  `hold_id`    VARCHAR(32) NOT NULL PRIMARY KEY COMMENT 'One holdstone per hold',
  `object_id`  VARCHAR(64) NOT NULL COMMENT 'FormDesc of the world object acting as the stone, e.g. 162e2:Skyrim.esm',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_holdstones_object` (`object_id`),
  CONSTRAINT `fk_holdstone_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hold_ranks` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `hold_id`    VARCHAR(32) NOT NULL,
  `rank_key`   VARCHAR(32) NOT NULL COMMENT 'Short lowercase key used in menus and commands (citizen, guard...)',
  `name`       VARCHAR(64) NOT NULL COMMENT 'Display name',
  `position`   SMALLINT NOT NULL COMMENT 'Ladder order; higher = more authority',
  `is_leader`  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = may set ranks below their own and manage parcels',
  UNIQUE KEY `uq_hold_ranks_key` (`hold_id`, `rank_key`),
  UNIQUE KEY `uq_hold_ranks_position` (`hold_id`, `position`),
  CONSTRAINT `fk_hold_rank_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hold_members` (
  `hold_id`      VARCHAR(32) NOT NULL,
  `character_id` INT NOT NULL,
  `rank_id`      INT NOT NULL,
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`hold_id`, `character_id`),
  CONSTRAINT `fk_hold_member_hold`      FOREIGN KEY (`hold_id`)      REFERENCES `holds` (`id`)      ON DELETE CASCADE,
  CONSTRAINT `fk_hold_member_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hold_member_rank`      FOREIGN KEY (`rank_id`)      REFERENCES `hold_ranks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `parcels` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `hold_id`            VARCHAR(32) NOT NULL,
  `name`               VARCHAR(64) NOT NULL,
  `owner_character_id` INT NULL DEFAULT NULL COMMENT 'NULL = no owner',
  `min_rank_id`        INT NULL DEFAULT NULL COMMENT 'NULL = owner and staff only',
  `locked`             TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = open to everyone',
  `created_at`         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_parcels_hold_name` (`hold_id`, `name`),
  CONSTRAINT `fk_parcel_hold`     FOREIGN KEY (`hold_id`)            REFERENCES `holds` (`id`)       ON DELETE CASCADE,
  CONSTRAINT `fk_parcel_owner`    FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`)  ON DELETE SET NULL,
  CONSTRAINT `fk_parcel_min_rank` FOREIGN KEY (`min_rank_id`)        REFERENCES `hold_ranks` (`id`)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `parcel_objects` (
  `object_id`         VARCHAR(64) NOT NULL PRIMARY KEY COMMENT 'FormDesc of the door/container reference; one parcel per object',
  `parcel_id`         INT NOT NULL,
  `kind`              ENUM('door', 'container') NOT NULL,
  `locks`             TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = exit side of a load door: listed, never blocks',
  `partner_object_id` VARCHAR(64) NULL DEFAULT NULL COMMENT 'Other side of a load door (teleport pair), when known',
  `created_at`        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_parcel_object_parcel` FOREIGN KEY (`parcel_id`) REFERENCES `parcels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `hold_members`
  ADD INDEX IF NOT EXISTS `idx_hold_members_character` (`character_id`);

ALTER TABLE `parcels`
  ADD INDEX IF NOT EXISTS `idx_parcels_owner` (`owner_character_id`);

ALTER TABLE `parcel_objects`
  ADD INDEX IF NOT EXISTS `idx_parcel_objects_parcel` (`parcel_id`);

-- Default ladder for every existing hold. Staff can rename, add or remove
-- ranks per hold afterwards (/holdstone addrank, /holdstone delrank).
INSERT IGNORE INTO `hold_ranks` (`hold_id`, `rank_key`, `name`, `position`, `is_leader`)
  SELECT `id`, 'citizen', 'Citizen', 10, 0 FROM `holds`;
INSERT IGNORE INTO `hold_ranks` (`hold_id`, `rank_key`, `name`, `position`, `is_leader`)
  SELECT `id`, 'guard', 'Guard', 20, 0 FROM `holds`;
INSERT IGNORE INTO `hold_ranks` (`hold_id`, `rank_key`, `name`, `position`, `is_leader`)
  SELECT `id`, 'steward', 'Steward', 30, 1 FROM `holds`;
INSERT IGNORE INTO `hold_ranks` (`hold_id`, `rank_key`, `name`, `position`, `is_leader`)
  SELECT `id`, 'jarl', 'Jarl', 40, 1 FROM `holds`;
