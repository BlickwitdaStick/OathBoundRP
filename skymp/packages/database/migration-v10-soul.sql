-- =============================================================================
-- Migration v10 - Soul Affinity (soul-service)
-- Apply after migration-v9-characters-gold.sql.
--
-- Design finalized in docs/design/SOUL_AFFINITY.md. The four tables below are
-- exactly the ones declared there (III.6 marks, III.7 signs, III.8 tree) plus
-- the `character_soul` table from §10, and nothing beyond that.
--
-- Why the soul lives in its own table rather than in columns of `characters`
-- -----------------------------------------------------------------------------
-- The approved sheet (`motivations`, `weaknesses`, `social_ties`, migration v5) is
-- the SOURCE of the soul, not the soul. Storing the seven values in `characters` would mix
-- what staff reviews with what the server derives, and the latter must never
-- be hand-editable from the panel — that is what guarantees the same approved sheet
-- always produces the same soul (§14.1, the end of reroll farming).
--
-- Why the seed is persisted instead of re-derived on each use
-- -----------------------------------------------------------------------------
-- It is derived from `HMAC(SOUL_SECRET, characterId || normalized sheet)`. If
-- staff edits the sheet of an already-approved character — which the panel allows —,
-- re-deriving would silently swap the soul of someone who has played with it for months.
-- Persisting freezes the soul at the moment of approval, which is the only behavior
-- compatible with "marks are the progression" (§II.3).
--
-- ⚠️ `soul_seed` is sensitive material. With it and the public code of this repository
-- anyone can reproduce every future roll of that character. It must never
-- leave the server, never goes into a `panelData` payload and never shows up in a
-- web panel endpoint. A test locks this down (soul-service.test.js).
--
-- Idempotent: `IF NOT EXISTS` on every creation.
-- =============================================================================
USE `skymp_rp`;

-- -----------------------------------------------------------------------------
-- The soul. Seven values (four affinities + three traits) and the seed that generated them.
-- One row per character, created on the first spawn after approval.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `character_soul` (
  `character_id` INT NOT NULL PRIMARY KEY,
  `soul_seed` CHAR(64) NOT NULL COMMENT 'HMAC hex. SENSITIVE: never leaves the server',
  `arcana` TINYINT UNSIGNED NOT NULL COMMENT '0-100. Fixed budget: the four affinities sum to 200',
  `divina` TINYINT UNSIGNED NOT NULL,
  `sombria` TINYINT UNSIGNED NOT NULL,
  `bestial` TINYINT UNSIGNED NOT NULL,
  `vontade` TINYINT UNSIGNED NOT NULL COMMENT '0-100. Fixed budget: the three traits sum to 150',
  `sensibilidade` TINYINT UNSIGNED NOT NULL,
  `estabilidade` TINYINT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_soul_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Signs (III.7). The first is revealed on the first spawn, not by play time:
-- that is what guarantees the first session is not empty (§II.1).
--
-- `sign_key` is a catalog key, never free text — the text lives in code,
-- for the same reason as `descriptor` in `character_marks`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `character_signs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `sign_key` VARCHAR(64) NOT NULL COMMENT 'Catalog key in soul-service.js. Never player text',
  `source` VARCHAR(32) NOT NULL DEFAULT 'first_spawn' COMMENT 'first_spawn, event, ritual',
  `revealed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_sign_character_key` (`character_id`, `sign_key`),
  CONSTRAINT `fk_sign_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Marks (III.6). They ARE the progression — there are no levels, there is what stayed with you.
--
-- A mark is never removed. At most it is covered, which is also playable and costly —
-- which is why there is no `removed_at` column and no status.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `character_marks` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `kind` VARCHAR(16) NOT NULL COMMENT 'fisica (physical), espiritual (spiritual), social',
  `visibility` VARCHAR(16) NOT NULL COMMENT 'visivel (others see it), sentida (only the bearer), conhecida (reputation)',
  `descriptor` VARCHAR(64) NOT NULL COMMENT 'Catalog key in soul-service.js. Never player text',
  `origin_event_id` VARCHAR(128) DEFAULT NULL COMMENT 'Trail back to the soul:resolve row in audit_logs',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_marks_character` (`character_id`),
  CONSTRAINT `fk_mark_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Transformation tree (III.8). A SIBLING state machine of
-- core/character-state.js, deliberately kept separate from it: that one handles
-- immediate gameplay state (NORMAL/DOWNED/IMPRISONED) with a lifecycle of seconds;
-- this one is a trajectory of months. Mixing them would couple things with
-- incompatible lifetimes (Constitution §13).
--
-- `consented_at` implements condition §14.2: an irreversible node does not advance
-- without recorded consent. NULL in it on an irreversible node is a process
-- bug, not a valid state — a test locks this down.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `character_paths` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `tree` VARCHAR(16) NOT NULL COMMENT 'arcana, divina, sombria, bestial',
  `node` VARCHAR(32) NOT NULL,
  `entered_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `consented_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Mandatory on an irreversible node (SOUL_AFFINITY §14.2)',
  `metadata` TEXT DEFAULT NULL COMMENT 'JSON',
  UNIQUE KEY `uk_path_character_tree` (`character_id`, `tree`),
  CONSTRAINT `fk_path_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
