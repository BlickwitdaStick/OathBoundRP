-- Database schema for SkyMP Heavy RP (MySQL/MariaDB)

CREATE DATABASE IF NOT EXISTS `skymp_rp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- If the database already existed (created by hand, e.g. in HeidiSQL), it may
-- have the server's default collation (utf8mb4_uca1400_ai_ci on MariaDB 11+).
-- Tables below inherit the database default, and later migrations declare
-- utf8mb4_unicode_ci explicitly; mixing the two makes foreign keys between
-- them fail (character_depots.hold_id -> holds.id, "incorrectly formed").
ALTER DATABASE `skymp_rp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `skymp_rp`;

-- 1. Player accounts (with VIP and monetization support)
CREATE TABLE IF NOT EXISTS `accounts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active, suspended, banned',
  -- VIP / Supporter
  `vip_level` INT NOT NULL DEFAULT 0 COMMENT '0: Standard, 1: Supporter, 2: VIP Gold, 3: VIP Platinum',
  `vip_expires_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'VIP expiry date (NULL for permanent or inactive)',
  `coins` INT NOT NULL DEFAULT 0 COMMENT 'Virtual store coins (obtained through donations)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Discord identities (login via Discord OAuth)
-- NOTE: access_token and refresh_token are not stored. The OAuth flow always
-- redirects back to Discord when the web session expires. Never persist OAuth
-- tokens in plain text. If ever needed, use AES-256-GCM with a key kept outside the database.
CREATE TABLE IF NOT EXISTS `discord_identities` (
  `discord_id` VARCHAR(64) PRIMARY KEY,
  `account_id` INT NOT NULL,
  `username` VARCHAR(128) NOT NULL,
  `avatar` VARCHAR(256) DEFAULT NULL,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Last login via Discord OAuth',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_discord_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Whitelist applications
CREATE TABLE IF NOT EXISTS `whitelist_applications` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending, approved, rejected',
  `reviewed_by` VARCHAR(128) DEFAULT NULL,
  `reviewer_notes` TEXT DEFAULT NULL,
  `reviewed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_whitelist_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Skyrim character sheets
CREATE TABLE IF NOT EXISTS `characters` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `first_name` VARCHAR(64) NOT NULL,
  `last_name` VARCHAR(64) NOT NULL,
  `biography` TEXT DEFAULT NULL,
  `motivations` TEXT DEFAULT NULL COMMENT 'Objetivos do personagem em jogo (rubrica de whitelist Heavy RP)',
  `weaknesses` TEXT DEFAULT NULL COMMENT 'Falhas/limites do personagem (rubrica de whitelist Heavy RP)',
  `social_ties` TEXT DEFAULT NULL COMMENT 'Laços sociais/relações pretendidas (rubrica de whitelist Heavy RP)',
  `needs_extra_review` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Conceito forte (nobre, mago poderoso, vampiro, lobisomem, lider de faccao) — exige aprovacao extra da staff antes de approved',
  `extra_review_notes` TEXT DEFAULT NULL COMMENT 'Notas da staff sobre a revisao extra do conceito',
  -- Logout position (default: the Sleeping Giant Inn, Riverwood)
  `pos_x` FLOAT NOT NULL DEFAULT -977.0,
  `pos_y` FLOAT NOT NULL DEFAULT 9.0,
  `pos_z` FLOAT NOT NULL DEFAULT 5.0,
  `angle_z` FLOAT NOT NULL DEFAULT 137.0,
  `cell_id` VARCHAR(64) NOT NULL DEFAULT '133c6:Skyrim.esm',
  `gold` INT NOT NULL DEFAULT 0 COMMENT 'Economia in-game (Septims)',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending, approved, rejected, retired (soft-delete, ver admin-service.retireCharacter)',
  `racemenu_presets` TEXT DEFAULT NULL COMMENT 'JSON string contendo presets de aparencia',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_character_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4.1. Identities a character knows (who they recognize, and by which name)
CREATE TABLE IF NOT EXISTS `character_known_identities` (
  `observer_character_id` INT NOT NULL,
  `target_character_id` INT NOT NULL,
  `display_name` VARCHAR(64) NOT NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'introduced' COMMENT 'introduced, alias, staff, disguise',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`observer_character_id`, `target_character_id`),
  CONSTRAINT `fk_known_observer` FOREIGN KEY (`observer_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_known_target` FOREIGN KEY (`target_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4.2. Persistent character inventory
CREATE TABLE IF NOT EXISTS `character_inventory` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `base_id` INT NOT NULL COMMENT 'Native Skyrim FormID (decimal)',
  `count` INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_inventory_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Persistent containers (server-controlled chests)
CREATE TABLE IF NOT EXISTS `containers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `object_id` VARCHAR(64) NOT NULL UNIQUE COMMENT 'formDesc of the world object (e.g. 0x3003A:Skyrim.esm)',
  `owner_character_id` INT DEFAULT NULL COMMENT 'Character that owns the container',
  `label` VARCHAR(128) DEFAULT NULL COMMENT 'Custom chest label',
  `is_locked` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_container_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.1. Container inventory
CREATE TABLE IF NOT EXISTS `container_inventory` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `container_id` INT NOT NULL,
  `base_id` INT NOT NULL COMMENT 'Native Skyrim FormID (decimal)',
  `count` INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_container_inv` FOREIGN KEY (`container_id`) REFERENCES `containers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Properties and real estate
CREATE TABLE IF NOT EXISTS `properties` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL COMMENT 'Property name (e.g. House in Whiterun 12)',
  `owner_character_id` INT DEFAULT NULL,
  `container_id` INT DEFAULT NULL COMMENT 'Main container of the property',
  `door_form_desc` VARCHAR(64) DEFAULT NULL COMMENT 'formDesc of the entrance door',
  `price_gold` INT NOT NULL DEFAULT 0 COMMENT 'Rent/purchase price in Septims',
  `is_for_sale` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_property_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_property_container` FOREIGN KEY (`container_id`) REFERENCES `containers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 6.1. Guest access to properties
CREATE TABLE IF NOT EXISTS `property_guests` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `property_id` INT NOT NULL,
  `guest_character_id` INT NOT NULL,
  `granted_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_guest_property` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_guest_character` FOREIGN KEY (`guest_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Supporter store purchases and redemptions
CREATE TABLE IF NOT EXISTS `store_purchases` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `item_type` VARCHAR(64) NOT NULL COMMENT 'cosmetic, slot, vip_subscription, custom_housing',
  `item_name` VARCHAR(128) NOT NULL,
  `cost_coins` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_store_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Audit and staff logs
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `action` VARCHAR(128) NOT NULL,
  `actor_account_id` INT DEFAULT NULL,
  `target_account_id` INT DEFAULT NULL,
  `details` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 7. Criminal records
CREATE TABLE IF NOT EXISTS `criminal_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `crime` VARCHAR(128) NOT NULL COMMENT 'Murder, Theft, Assault, Disturbance...',
  `bounty` INT NOT NULL DEFAULT 0 COMMENT 'Bounty amount in Septims',
  `hold` VARCHAR(64) NOT NULL DEFAULT 'whiterun' COMMENT 'Hold where the crime was committed',
  `witness_character_id` INT DEFAULT NULL COMMENT 'Guard or witness who reported it',
  `resolved` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0=Active, 1=Paid/Served',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_crime_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8. Active and past imprisonments
CREATE TABLE IF NOT EXISTS `prison_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `arrested_by_character_id` INT DEFAULT NULL COMMENT 'Guard who made the arrest',
  `crime_summary` TEXT DEFAULT NULL,
  `sentence_minutes` INT NOT NULL DEFAULT 10 COMMENT 'Sentence length in in-game minutes',
  `time_served_minutes` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active, released, escaped',
  `cell_id` VARCHAR(64) NOT NULL DEFAULT '580a2:Skyrim.esm' COMMENT 'Celula da prisao',
  `arrested_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `released_at` TIMESTAMP NULL DEFAULT NULL,
  CONSTRAINT `fk_prison_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8.1. Current restraint state
CREATE TABLE IF NOT EXISTS `character_restraints` (
  `character_id` INT PRIMARY KEY,
  `restrained_by_character_id` INT DEFAULT NULL,
  `type` VARCHAR(32) NOT NULL DEFAULT 'handcuffs' COMMENT 'handcuffs, rope',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_restraint_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════
-- BETA PHASE - Survival, Regional Economy, Crafting, Factions
-- ═══════════════════════════════════════════════════

-- 9. Character survival stats
CREATE TABLE IF NOT EXISTS `character_survival` (
  `character_id` INT PRIMARY KEY,
  `hunger`       FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Starving, 100=Sated',
  `thirst`       FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Dehydrated, 100=Hydrated',
  `fatigue`      FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Exhausted, 100=Rested',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_survival_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 10. Holds (regions) and their economy
CREATE TABLE IF NOT EXISTS `holds` (
  `id`           VARCHAR(32) PRIMARY KEY COMMENT 'whiterun, solitude, riften, windhelm, markarth, falkreath, morthal, dawnstar, winterhold',
  `name`         VARCHAR(64) NOT NULL,
  `tax_rate`     FLOAT NOT NULL DEFAULT 0.05 COMMENT 'Sales tax (0.05 = 5%)',
  `treasury`     INT NOT NULL DEFAULT 0 COMMENT 'Gold accumulated from taxes',
  `ruling_faction_id` INT DEFAULT NULL COMMENT 'Faction that controls the Hold'
) ENGINE=InnoDB;

-- 10.1. Regional market prices (supply and demand)
CREATE TABLE IF NOT EXISTS `market_prices` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `hold_id`      VARCHAR(32) NOT NULL,
  `base_id`      INT NOT NULL COMMENT 'Item FormID',
  `buy_price`    INT NOT NULL DEFAULT 10 COMMENT 'Price the player buys at',
  `sell_price`   INT NOT NULL DEFAULT 7  COMMENT 'Price the player sells at',
  `stock`        INT NOT NULL DEFAULT 100 COMMENT 'Available stock (supply)',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_hold_item` (`hold_id`, `base_id`),
  CONSTRAINT `fk_market_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `regional_market_transactions` (
  `transaction_id` CHAR(36) NOT NULL PRIMARY KEY,
  `idempotency_key` VARCHAR(64) NOT NULL,
  `actor_character_id` INT NOT NULL,
  `hold_id` VARCHAR(32) NOT NULL,
  `direction` ENUM('buy', 'sell') NOT NULL,
  `base_id` INT NOT NULL,
  `count` INT NOT NULL,
  `unit_price` INT NOT NULL,
  `gross_amount` INT NOT NULL,
  `tax_amount` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_regional_market_idempotency` (`idempotency_key`),
  KEY `idx_regional_market_hold_date` (`hold_id`, `created_at`),
  KEY `idx_regional_market_character_date` (`actor_character_id`, `created_at`),
  CONSTRAINT `fk_regional_market_character` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_regional_market_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 10.2. Trade routes between Holds
CREATE TABLE IF NOT EXISTS `trade_routes` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `from_hold`    VARCHAR(32) NOT NULL,
  `to_hold`      VARCHAR(32) NOT NULL,
  `bonus_pct`    FLOAT NOT NULL DEFAULT 0.15 COMMENT 'Profit bonus when selling in another Hold',
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- 11. Crafting recipes
CREATE TABLE IF NOT EXISTS `crafting_recipes` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `name`         VARCHAR(128) NOT NULL,
  `station_type` VARCHAR(64)  NOT NULL COMMENT 'forge, cooking_pot, tanning_rack, alchemy_lab, enchanting_table',
  `result_base_id` INT NOT NULL COMMENT 'FormID of the resulting item',
  `result_count`   INT NOT NULL DEFAULT 1,
  `requires_perk`  VARCHAR(64) DEFAULT NULL COMMENT 'Name of the required perk',
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 11.1. Recipe ingredients
CREATE TABLE IF NOT EXISTS `crafting_ingredients` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `recipe_id`    INT NOT NULL,
  `base_id`      INT NOT NULL COMMENT 'Ingredient FormID',
  `count`        INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_ingredient_recipe` FOREIGN KEY (`recipe_id`) REFERENCES `crafting_recipes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 12. Factions and territories
CREATE TABLE IF NOT EXISTS `factions` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `tag`          VARCHAR(16) NOT NULL UNIQUE COMMENT 'E.g. [COMP], [GUARD]',
  `name`         VARCHAR(128) NOT NULL,
  `description`  TEXT DEFAULT NULL,
  `color_hex`    VARCHAR(7) NOT NULL DEFAULT '#ffffff',
  `leader_character_id` INT DEFAULT NULL,
  `treasury`     INT NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_faction_leader` FOREIGN KEY (`leader_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 12.0. Institutional treasury ledger (Hold <-> Faction)
CREATE TABLE IF NOT EXISTS `institutional_treasury_transactions` (
  `transfer_id` CHAR(36) NOT NULL PRIMARY KEY,
  `idempotency_key` VARCHAR(64) NOT NULL,
  `actor_character_id` INT NOT NULL,
  `hold_id` VARCHAR(32) NOT NULL,
  `faction_id` INT NOT NULL,
  `amount` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_institutional_treasury_idempotency` (`idempotency_key`),
  KEY `idx_institutional_treasury_hold_date` (`hold_id`, `created_at`),
  KEY `idx_institutional_treasury_faction_date` (`faction_id`, `created_at`),
  CONSTRAINT `fk_institutional_treasury_actor` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_institutional_treasury_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_institutional_treasury_faction` FOREIGN KEY (`faction_id`) REFERENCES `factions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 12.1. Faction members
CREATE TABLE IF NOT EXISTS `faction_members` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `faction_id`   INT NOT NULL,
  `character_id` INT NOT NULL,
  `rank`         VARCHAR(64) NOT NULL DEFAULT 'recruit',
  `joined_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_char_faction` (`character_id`, `faction_id`),
  CONSTRAINT `fk_member_faction`   FOREIGN KEY (`faction_id`)   REFERENCES `factions`   (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_member_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Seed: initial Holds ──────────────────────────────────────────────────────
-- Correct mapping: ID = hold slug, name = name of the hold (not of the city)
-- Capital city → Hold: Whiterun→Whiterun Hold, Solitude→Haafingar,
-- Riften→The Rift, Windhelm→Eastmarch, Markarth→The Reach,
-- Falkreath→Falkreath Hold, Morthal→Hjaalmarch, Dawnstar→The Pale, Winterhold→Winterhold
INSERT IGNORE INTO `holds` (`id`, `name`, `tax_rate`) VALUES
  ('whiterun',    'Whiterun Hold',        0.05),
  ('solitude',    'Haafingar',            0.07),
  ('riften',      'The Rift',             0.06),
  ('windhelm',    'Eastmarch',            0.05),
  ('markarth',    'The Reach',            0.08),
  ('falkreath',   'Falkreath Hold',       0.04),
  ('morthal',     'Hjaalmarch',           0.04),
  ('dawnstar',    'The Pale',             0.05),
  ('winterhold',  'Winterhold',           0.03);

-- ═══════════════════════════════════════════════════
-- ADMINISTRATIVE AUTHORITY — Staff kept separate from VIP/Supporter
-- ═══════════════════════════════════════════════════

-- A. Staff roles (separate from vip_level)
-- vip_level in the accounts table is ONLY for monetization (0-3).
-- Administrative power NEVER derives from vip_level.
CREATE TABLE IF NOT EXISTS `staff_roles` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,
  `account_id`            INT NOT NULL UNIQUE,
  `role`                  VARCHAR(32) NOT NULL COMMENT 'moderator, admin, owner',
  `granted_by_account_id` INT DEFAULT NULL COMMENT 'Who granted the role',
  `notes`                 VARCHAR(256) DEFAULT NULL,
  `granted_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_staff_account`  FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_staff_grantor` FOREIGN KEY (`granted_by_account_id`) REFERENCES `accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- B. Granular per-role permissions (for future fine-grained control)
CREATE TABLE IF NOT EXISTS `staff_permissions` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `staff_role_id` INT NOT NULL,
  `permission`    VARCHAR(64) NOT NULL COMMENT 'kick, ban, teleport, add_item, set_gold, view_audit, manage_whitelist',
  UNIQUE KEY `uk_role_perm` (`staff_role_id`, `permission`),
  CONSTRAINT `fk_perm_role` FOREIGN KEY (`staff_role_id`) REFERENCES `staff_roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Seed: default permissions per role ───────────────────────────────────────
-- Inserted once staff_roles rows exist (by the application).
-- Reference: moderator=[kick,teleport,view_audit], admin=[+ban,add_item,set_gold], owner=[all]

-- ═══════════════════════════════════════════════════
-- FINANCIAL LEDGER — Auditable inventory and gold transactions
-- ═══════════════════════════════════════════════════

-- C. Inventory ledger
-- Every item change goes through here. Never modify character_inventory directly.
CREATE TABLE IF NOT EXISTS `inventory_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY COMMENT 'UUID v4',
  `character_id`     INT          NOT NULL,
  `base_id`          INT          NOT NULL COMMENT 'Native Skyrim FormID',
  `delta`            INT          NOT NULL COMMENT 'Positive = gained, Negative = lost',
  `reason`           VARCHAR(64)  NOT NULL COMMENT 'woodcutting, admin_give, trade, craft, loot...',
  `module`           VARCHAR(32)  NOT NULL COMMENT 'Module that originated the transaction',
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE COMMENT 'Prevents duplicates on retries',
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed' COMMENT 'committed, rolled_back',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_inv_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_inv_tx_char_date` (`character_id`, `created_at`)
) ENGINE=InnoDB;

-- D. Gold ledger
CREATE TABLE IF NOT EXISTS `gold_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY COMMENT 'UUID v4',
  `character_id`     INT          NOT NULL,
  `delta`            INT          NOT NULL COMMENT 'Positive = gained, Negative = lost',
  `reason`           VARCHAR(64)  NOT NULL,
  `module`           VARCHAR(32)  NOT NULL,
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE,
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_gold_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_gold_tx_char_date` (`character_id`, `created_at`)
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════
-- PARKED SYSTEMS — Horses, Disguises, Magic, Diseases
-- ═══════════════════════════════════════════════════

-- 13. Persistent horses
-- The 'Cavalo' default is a historical Portuguese value kept so this baseline
-- matches existing databases; migration-v31 switches the default to 'Horse'.
CREATE TABLE IF NOT EXISTS `horses` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `name`           VARCHAR(64)  NOT NULL DEFAULT 'Cavalo',
  `base_id`        INT          NOT NULL COMMENT 'Race FormID (e.g. 0x00067C43)',
  `owner_character_id` INT DEFAULT NULL,
  `health`         FLOAT NOT NULL DEFAULT 500.0,
  `speed_bonus`    FLOAT NOT NULL DEFAULT 0.0  COMMENT 'Trained speed bonus',
  `last_pos_x`     FLOAT DEFAULT NULL,
  `last_pos_y`     FLOAT DEFAULT NULL,
  `last_pos_z`     FLOAT DEFAULT NULL,
  `last_cell`      VARCHAR(64) DEFAULT NULL,
  `for_sale`       TINYINT(1) NOT NULL DEFAULT 0,
  `sale_price`     INT NOT NULL DEFAULT 0,
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_horse_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 14. Disguises and false identities
CREATE TABLE IF NOT EXISTS `disguises` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `fake_name`      VARCHAR(128) NOT NULL,
  `fake_faction_id` INT DEFAULT NULL  COMMENT 'Faction being impersonated',
  `is_active`      TINYINT(1) NOT NULL DEFAULT 0,
  `detection_roll` INT NOT NULL DEFAULT 15  COMMENT 'Perception DC to detect (1-20)',
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_char_disguise` (`character_id`),
  CONSTRAINT `fk_disguise_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15. Magic licenses (spells approved for RP)
CREATE TABLE IF NOT EXISTS `magic_licenses` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `spell_name`     VARCHAR(128) NOT NULL,
  `spell_base_id`  INT NOT NULL  COMMENT 'Spell FormID',
  `school`         VARCHAR(32) NOT NULL DEFAULT 'alteration' COMMENT 'alteration, conjuration, destruction, illusion, restoration',
  `level`          VARCHAR(16) NOT NULL DEFAULT 'novice' COMMENT 'novice, apprentice, adept, expert, master',
  `granted_by_character_id` INT DEFAULT NULL,
  `narrative_justification` TEXT DEFAULT NULL,
  `granted_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_magic_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15.1. Unauthorized magic use (for audit)
CREATE TABLE IF NOT EXISTS `magic_violations` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `spell_base_id`  INT NOT NULL,
  `location`       VARCHAR(64) DEFAULT NULL,
  `detected_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_violation_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 16. Persistent diseases
CREATE TABLE IF NOT EXISTS `character_diseases` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `disease`        VARCHAR(64)  NOT NULL COMMENT 'rockjoint, ataxia, brain_rot, witbane, rattles, vampirism_stage1',
  `severity`       INT NOT NULL DEFAULT 1  COMMENT '1=Mild, 2=Moderate, 3=Severe',
  `contracted_at`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `cured_at`       TIMESTAMP NULL DEFAULT NULL,
  `is_active`      TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT `fk_disease_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17. Soul affinity (soul-service)
-- Design: docs/design/SOUL_AFFINITY.md. The reasoning behind each modelling
-- decision lives in migration-v10-soul.sql, which creates these same four
-- tables on an existing database.
-- Column names (arcana, divina, sombria, vontade...) and stored values
-- (fisica, visivel...) are Portuguese keys the code compares against; they are
-- identifiers, not prose, and stay as they are.

-- 17.1. The soul: seven values derived from the approved sheet, plus the seed.
-- SENSITIVE: `soul_seed` never leaves the server (see §III.3).
CREATE TABLE IF NOT EXISTS `character_soul` (
  `character_id`  INT NOT NULL PRIMARY KEY,
  `soul_seed`     CHAR(64) NOT NULL COMMENT 'HMAC hex. SENSITIVE: never leaves the server',
  `arcana`        TINYINT UNSIGNED NOT NULL COMMENT '0-100. The four affinities sum to 200',
  `divina`        TINYINT UNSIGNED NOT NULL,
  `sombria`       TINYINT UNSIGNED NOT NULL,
  `bestial`       TINYINT UNSIGNED NOT NULL,
  `vontade`       TINYINT UNSIGNED NOT NULL COMMENT '0-100. The three traits sum to 150',
  `sensibilidade` TINYINT UNSIGNED NOT NULL,
  `estabilidade`  TINYINT UNSIGNED NOT NULL,
  `created_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_soul_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.2. Signs: the first one appears on the first spawn, so that the first
-- session is not empty. `sign_key` is a catalog key, never player text.
CREATE TABLE IF NOT EXISTS `character_signs` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `sign_key`     VARCHAR(64) NOT NULL COMMENT 'Catalog key in soul-service.js',
  `source`       VARCHAR(32) NOT NULL DEFAULT 'first_spawn' COMMENT 'first_spawn, event, ritual',
  `revealed_at`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_sign_character_key` (`character_id`, `sign_key`),
  CONSTRAINT `fk_sign_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.3. Marks: they are the progression. A mark is never removed, at most
-- covered — which is why there is no `removed_at` and no status.
CREATE TABLE IF NOT EXISTS `character_marks` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`    INT NOT NULL,
  `kind`            VARCHAR(16) NOT NULL COMMENT 'fisica (physical), espiritual (spiritual), social',
  `visibility`      VARCHAR(16) NOT NULL COMMENT 'visivel (visible), sentida (felt), conhecida (known)',
  `descriptor`      VARCHAR(64) NOT NULL COMMENT 'Catalog key in soul-service.js',
  `origin_event_id` VARCHAR(128) DEFAULT NULL COMMENT 'Trail back to the soul:resolve row in audit_logs',
  `created_at`      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_marks_character` (`character_id`),
  CONSTRAINT `fk_mark_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.4. Transformation tree: a state machine sibling to
-- core/character-state.js, deliberately kept separate from it (seconds vs months).
-- `consented_at` is mandatory on an irreversible node (SOUL_AFFINITY §14.2).
CREATE TABLE IF NOT EXISTS `character_paths` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `tree`         VARCHAR(16) NOT NULL COMMENT 'arcana, divina, sombria, bestial',
  `node`         VARCHAR(32) NOT NULL,
  `entered_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `consented_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Mandatory on an irreversible node',
  `metadata`     TEXT DEFAULT NULL COMMENT 'JSON',
  UNIQUE KEY `uk_path_character_tree` (`character_id`, `tree`),
  CONSTRAINT `fk_path_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
