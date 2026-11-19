-- =============================================================================
-- Migration v5 - Deepens the character application (Heavy RP rubric)
-- Apply after migration-v4-market-stalls.sql.
--
-- The development plan (section 8.1, "Whitelist Standard") requires the
-- application to test the character's concept, motivations, weaknesses and
-- social ties, and that strong concepts (nobles, powerful mages, vampires,
-- werewolves, faction leaders) require extra staff approval. Before this
-- migration the application only collected first_name/last_name/biography.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `characters`
  ADD COLUMN IF NOT EXISTS `motivations` TEXT DEFAULT NULL
    COMMENT 'In-game goals of the character (Heavy RP whitelist rubric)'
    AFTER `biography`,
  ADD COLUMN IF NOT EXISTS `weaknesses` TEXT DEFAULT NULL
    COMMENT 'Flaws/limits of the character (Heavy RP whitelist rubric)'
    AFTER `motivations`,
  ADD COLUMN IF NOT EXISTS `social_ties` TEXT DEFAULT NULL
    COMMENT 'Intended social ties/relationships (Heavy RP whitelist rubric)'
    AFTER `weaknesses`,
  ADD COLUMN IF NOT EXISTS `needs_extra_review` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Strong concept - needs extra staff approval before approved'
    AFTER `social_ties`,
  ADD COLUMN IF NOT EXISTS `extra_review_notes` TEXT DEFAULT NULL
    COMMENT 'Staff notes on the extra concept review'
    AFTER `needs_extra_review`;
