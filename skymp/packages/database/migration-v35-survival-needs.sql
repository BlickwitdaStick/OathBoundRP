-- =============================================================================
-- Migration v35 - Survival needs (hunger, exhaustion, cold)
-- Apply after migration-v34-gold-sync.sql.
--
-- Server-side survival (gamemode/survival-service.js, rules in
-- core/survival-needs.js). One row per character, written while they play and
-- at logout, so needs carry over between sessions instead of resetting at each
-- login. Needs only change while the character is online. Values run from 0
-- (fine) to the need's maximum (hunger 1000, exhaustion 960, cold 1000).
--
-- Not `character_survival`: that table is in schema.sql from the survival
-- service deleted on 2026-08-06 (hunger/thirst/fatigue, never used since).
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `character_needs` (
  `character_id` INT NOT NULL PRIMARY KEY,
  `hunger`       FLOAT NOT NULL DEFAULT 0 COMMENT '0..1000, higher is hungrier',
  `exhaustion`   FLOAT NOT NULL DEFAULT 0 COMMENT '0..960, higher is more tired',
  `cold`         FLOAT NOT NULL DEFAULT 0 COMMENT '0..1000, higher is colder',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_needs_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
