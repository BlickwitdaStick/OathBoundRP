-- =============================================================================
-- Migration v36 - Skills, attributes, soul level and persisted mod progression
-- Apply after migration-v35-survival-needs.sql.
--
-- Rules live in gamemode/core/skills.js (tiers, EXP curve, attributes, slots)
-- and gamemode/core/skill-trees.js (tree nodes). Service: skills-service.js
-- (ENABLE_SKILLS_SERVICE). Tiers for every track: Novice 1-19, Apprentice
-- 20-39, Adept 40-59, Expert 60-79, Master 80-99, Legendary 100 (staff only).
-- =============================================================================
USE `skymp_rp`;

-- One row per character once they make their first choice in the F3 menu.
CREATE TABLE IF NOT EXISTS `character_progression` (
  `character_id`     INT NOT NULL PRIMARY KEY,
  `race_key`         VARCHAR(32) NOT NULL COMMENT 'core/skills.js RACES key the base attributes came from',
  `is_female`        TINYINT(1) NOT NULL DEFAULT 0,
  `attr_base`        TEXT NOT NULL COMMENT 'JSON {agility,endurance,...} from the race/sex table',
  `attr_added`       TEXT NOT NULL COMMENT 'JSON {spent:{...}, staff:{...}}: points the player spent, and staff edits',
  `magic_unlocked`   TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Spellcasting basics granted by staff or a magic Master',
  `magic_unlocked_by` INT DEFAULT NULL COMMENT 'character_id of the teacher, NULL = staff',
  `soul_exp`         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `soul_legendary`   TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_progression_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A skill the character owns. `primary` levels to 99; `secondary` (trained by
-- a Master or staff) caps at Adept 59. Level is derived from `exp`.
CREATE TABLE IF NOT EXISTS `character_skills` (
  `character_id`     INT NOT NULL,
  `skill_code`       VARCHAR(32) NOT NULL,
  `slot`             ENUM('primary','secondary') NOT NULL,
  `exp`              BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `legendary`        TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Level 100, staff only',
  `legendary_bonus`  VARCHAR(200) DEFAULT NULL COMMENT 'Bonus skill awarded for RP at Legendary',
  `trained_by`       INT DEFAULT NULL COMMENT 'character_id of the Master who trained a secondary',
  `granted_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`character_id`, `skill_code`),
  CONSTRAINT `fk_skills_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tree nodes bought with skill points (Master unlocks the whole tree anyway).
CREATE TABLE IF NOT EXISTS `character_skill_nodes` (
  `character_id`     INT NOT NULL,
  `skill_code`       VARCHAR(32) NOT NULL,
  `node_code`        VARCHAR(48) NOT NULL,
  `unlocked_at`      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`character_id`, `skill_code`, `node_code`),
  CONSTRAINT `fk_skill_nodes_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Perks/spells given by client-side mod scripts (Mundus standing stones,
-- Pilgrim shrines, later Apprentice classes). SkyMP does not save these; the
-- server mirrors what the client reports and re-applies it at every login.
-- Stored as "0xLOCALID:Plugin.esp" so a load-order change keeps them valid.
CREATE TABLE IF NOT EXISTS `character_mod_forms` (
  `character_id`     INT NOT NULL,
  `form_kind`        ENUM('perk','spell') NOT NULL,
  `form_desc`        VARCHAR(160) NOT NULL,
  `recorded_at`      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`character_id`, `form_kind`, `form_desc`),
  CONSTRAINT `fk_mod_forms_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail of staff/teacher actions (EXP grants, training, Legendary).
-- Everyday EXP from use is not logged row by row.
CREATE TABLE IF NOT EXISTS `skill_audit_log` (
  `id`               BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `character_id`     INT NOT NULL,
  `skill_code`       VARCHAR(32) NOT NULL COMMENT 'skill code, or soul / attributes / magic',
  `action`           VARCHAR(32) NOT NULL,
  `amount`           BIGINT DEFAULT NULL,
  `detail`           VARCHAR(255) DEFAULT NULL,
  `by_character_id`  INT DEFAULT NULL,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_skill_audit_character` (`character_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
