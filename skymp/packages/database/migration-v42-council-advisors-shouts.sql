-- =============================================================================
-- Migration v42 - The Council: Advisors, summons and Council-granted shouts
-- Apply after migration-v41-stone-organizations.sql. Safe to run again.
--
-- OATHBOUND RP Design, phase 1:
-- - advisors: one Advisor per organization (a hold), a title granted and
--   removed only by staff. Outranks the Jarl; answers to the Council.
-- - council_summons: an Advisor calls the Council from the High Hrothgar
--   stone; a Councilor (staff) answers there.
-- - character_shouts: shout words the Council granted a character. SkyMP does
--   not save learned words, so the server gives them back at every login.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `advisors` (
  `character_id`          INT NOT NULL PRIMARY KEY,
  `org_id`                VARCHAR(32) NOT NULL COMMENT 'The hold (stone organization) they advise',
  `granted_by_account_id` INT NULL DEFAULT NULL,
  `granted_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_advisors_org` (`org_id`),
  CONSTRAINT `fk_advisor_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_advisor_org`       FOREIGN KEY (`org_id`)       REFERENCES `stone_orgs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `council_summons` (
  `id`                     INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`           INT NOT NULL COMMENT 'Who summoned (an Advisor, or staff testing)',
  `org_id`                 VARCHAR(32) NULL DEFAULT NULL COMMENT 'The hold they advise, if any',
  `reason`                 VARCHAR(255) NOT NULL,
  `status`                 ENUM('open', 'answered', 'unanswered') NOT NULL DEFAULT 'open',
  `answered_by_account_id` INT NULL DEFAULT NULL,
  `outcome`                VARCHAR(255) NULL DEFAULT NULL,
  `created_at`             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `answered_at`            TIMESTAMP NULL DEFAULT NULL,
  KEY `idx_council_summons_status` (`status`, `created_at`),
  CONSTRAINT `fk_summons_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `character_shouts` (
  `character_id`          INT NOT NULL,
  `word_desc`             VARCHAR(64) NOT NULL COMMENT 'FormDesc of the WOOP (word of power), e.g. 602a3:Skyrim.esm',
  `shout_desc`            VARCHAR(64) NOT NULL COMMENT 'FormDesc of the SHOU the word belongs to',
  `granted_by_account_id` INT NULL DEFAULT NULL,
  `reason`                VARCHAR(255) NULL DEFAULT NULL,
  `granted_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`character_id`, `word_desc`),
  CONSTRAINT `fk_character_shouts_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
