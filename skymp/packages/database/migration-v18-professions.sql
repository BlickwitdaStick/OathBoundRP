-- v18 — character_professions: the persistent state of the Profession Core
--
-- ═══════════════════════════════════════════════════════════════════════════
-- What this migration creates, and what it deliberately does NOT create
-- ═══════════════════════════════════════════════════════════════════════════
--
-- It creates ONLY `character_professions`. The original briefing (§3) also suggested a
-- `professions` table (id, code, name, category, enabled) for the catalog.
-- It is not included here, and the omission is a decision, not an oversight:
--
--   * The thirteen professions are fixed in code (core/profession-registry.js) and
--     nothing in this phase allows creating a new profession at runtime — there is no
--     admin action, panel or command for it. A table with no writer other than
--     a seed migration would be a pure mirror of the registry, with no extra
--     degree of freedom.
--   * The project already has the exact precedent for "closed catalog, validated in
--     code, no table of its own": `crafting_recipes.station_type` is
--     `VARCHAR(64)` with the list of values in the COMMENT, not an FK to a
--     `crafting_stations` table. `character_professions.profession_code`
--     follows the same pattern below.
--   * §3 of the briefing itself asks to "evaluate the real need" before creating a
--     table — applied to the letter here, not only to the `ProfessionRank` the text
--     cites as an example.
--
-- If a future phase allows per-server custom professions (outside the
-- code), the `professions` table makes sense again — and this migration
-- does not prevent it: `profession_code` is still just a VARCHAR.
--
-- No rank, XP-curve, ResourceNode, contract or crafting table goes in
-- here — they belong to the following phases (Resource Node Framework onwards).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why ONE table, with a status, and not INSERT/DELETE per grant
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `status` distinguishes active/suspended/revoked instead of the row existing or not,
-- because revoking a profession by DELETING the row would silently lose rank and XP
-- — §8 of the briefing asks for history to be preserved. The UNIQUE on
-- `(character_id, profession_code)` is what makes "granting a revoked
-- profession again" an UPDATE that reuses the row (and the old rank/XP),
-- instead of needing a second row for the same pair.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `character_professions` (
  `id`                       INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`             INT NOT NULL,

  -- Catalog closed in code, not in the database — see the comment above.
  -- Validated by core/profession-registry.js before any write here.
  `profession_code`          VARCHAR(32) NOT NULL COMMENT 'catalog code, see skymp/gamemode/core/profession-registry.js',

  `status`                   VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active, suspended, revoked',

  -- Numeric and with no universal label on purpose (§9 of the briefing): rank 0..N,
  -- each profession may one day have its own labels (Apprentice/Master/...)
  -- outside the database. Today's ceiling is the `profession.maxRank` option
  -- (core/server-options.js), not a CHECK constraint — this project's MySQL
  -- does not use CHECK on any other table, and range validation is already done in
  -- profession-service.js before the UPDATE.
  `rank`                     TINYINT UNSIGNED NOT NULL DEFAULT 0,

  -- Raw counter, no level curve (§10 of the briefing: "DO NOT implement a complex
  -- level-up curve in this phase"). UNSIGNED because profession-service.js
  -- never writes negative XP — the floor is always applied in code before the
  -- UPDATE, so the column does not need to allow negatives.
  `xp`                       INT UNSIGNED NOT NULL DEFAULT 0,

  -- Who granted (or reactivated) the profession. NULL is legitimate — today there is no
  -- path that grants without staff, but the column should not require a value that a
  -- future path (e.g. a guild NPC) may not have.
  `granted_by_character_id`  INT DEFAULT NULL,

  `joined_at`                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- The constraint that prevents the duplicate from §7 of the briefing ("same character +
  -- same profession + duplicates"), and what makes re-granting a revoked
  -- profession an UPDATE instead of a second INSERT.
  UNIQUE KEY `uk_character_profession` (`character_id`, `profession_code`),

  CONSTRAINT `fk_charprof_character`   FOREIGN KEY (`character_id`)            REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_charprof_granted_by`  FOREIGN KEY (`granted_by_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
-- No risk today: both FKs above are INT (character_id), collation does not
-- apply. But if a VARCHAR FK is added here against a table with an
-- explicit COLLATE (e.g. `holds`), it will break the same way
-- migration-v20-depot-service.sql broke — see the comment there. Declare
-- COLLATE=utf8mb4_unicode_ci explicitly if that happens.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
--
-- `idx_charprof_character` is what the concurrency query of
-- `grantProfession`/`reactivateProfession` uses (`SELECT ... WHERE character_id
-- = ? AND status = 'active' FOR UPDATE`): under REPEATABLE READ (the InnoDB
-- default), that SELECT with FOR UPDATE takes a next-key lock over the
-- index range, which serializes two concurrent grants for the SAME
-- character — that is what stops a character from exceeding
-- `profession.maxPerCharacter` under a race (§25 of the briefing).
--
-- `idx_charprof_status` serves a future admin query ("how many
-- active miners are there?"), which does not exist yet in this phase but is cheap
-- to have ready.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `character_professions`
  ADD INDEX IF NOT EXISTS `idx_charprof_character` (`character_id`),
  ADD INDEX IF NOT EXISTS `idx_charprof_status`    (`status`);
