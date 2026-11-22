-- =============================================================================
-- Migration v40 - Thirst joins hunger, exhaustion and cold
-- Apply after migration-v39-real-start-cell.sql. Safe to run again.
--
-- Brewer keeps drinks apart from food, so survival tracks thirst too
-- (core/survival-needs.js NEEDS.thirst, 0..1000, higher is thirstier). Existing
-- characters start quenched (0).
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `character_needs`
  ADD COLUMN IF NOT EXISTS `thirst` FLOAT NOT NULL DEFAULT 0 COMMENT '0..1000, higher is thirstier' AFTER `hunger`;
