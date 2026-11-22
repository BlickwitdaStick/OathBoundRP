-- =============================================================================
-- Migration v2 — SkyMP Heavy RP
-- Apply ONLY to databases that already ran the original schema.sql.
-- For new environments, just run schema.sql (it already includes these changes).
-- =============================================================================
USE `skymp_rp`;

-- -----------------------------------------------------------------------------
-- 1. SECURITY: Remove plain-text OAuth tokens
-- -----------------------------------------------------------------------------
-- If the columns exist, drop them. Use the last_login_at column instead.
ALTER TABLE `discord_identities`
  DROP COLUMN IF EXISTS `access_token`,
  DROP COLUMN IF EXISTS `refresh_token`;

ALTER TABLE `discord_identities`
  ADD COLUMN IF NOT EXISTS `last_login_at` TIMESTAMP NULL DEFAULT NULL
    COMMENT 'Last login via Discord OAuth'
    AFTER `avatar`;

-- -----------------------------------------------------------------------------
-- 2. FIX: Hold names from the Skyrim universe
-- -----------------------------------------------------------------------------
UPDATE `holds` SET `name` = 'Whiterun Hold'  WHERE `id` = 'whiterun'   AND `name` != 'Whiterun Hold';
UPDATE `holds` SET `name` = 'Haafingar'      WHERE `id` = 'solitude'   AND `name` != 'Haafingar';
UPDATE `holds` SET `name` = 'The Rift'       WHERE `id` = 'riften'     AND `name` != 'The Rift';
UPDATE `holds` SET `name` = 'Eastmarch'      WHERE `id` = 'windhelm'   AND `name` != 'Eastmarch';
UPDATE `holds` SET `name` = 'The Reach'      WHERE `id` = 'markarth'   AND `name` != 'The Reach';
UPDATE `holds` SET `name` = 'Falkreath Hold' WHERE `id` = 'falkreath'  AND `name` != 'Falkreath Hold';
UPDATE `holds` SET `name` = 'Hjaalmarch'     WHERE `id` = 'morthal'    AND `name` != 'Hjaalmarch';
UPDATE `holds` SET `name` = 'The Pale'       WHERE `id` = 'dawnstar'   AND `name` != 'The Pale';
UPDATE `holds` SET `name` = 'Winterhold'     WHERE `id` = 'winterhold' AND `name` != 'Winterhold';

-- -----------------------------------------------------------------------------
-- 3. STAFF × VIP: New administrative authority tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `staff_roles` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,
  `account_id`            INT NOT NULL UNIQUE,
  `role`                  VARCHAR(32) NOT NULL COMMENT 'moderator, admin, owner',
  `granted_by_account_id` INT DEFAULT NULL,
  `notes`                 VARCHAR(256) DEFAULT NULL,
  `granted_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_staff_account`  FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_staff_grantor` FOREIGN KEY (`granted_by_account_id`) REFERENCES `accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `staff_permissions` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `staff_role_id` INT NOT NULL,
  `permission`    VARCHAR(64) NOT NULL COMMENT 'kick, ban, teleport, add_item, set_gold, view_audit, manage_whitelist',
  UNIQUE KEY `uk_role_perm` (`staff_role_id`, `permission`),
  CONSTRAINT `fk_perm_role` FOREIGN KEY (`staff_role_id`) REFERENCES `staff_roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Migrate accounts that used vip_level as a staff indicator to the new table.
-- WARNING: Check manually before running. vip_level >= 10 was the old criterion.
-- After the migration, reset vip_level on those accounts to 0 (no commercial VIP).
INSERT IGNORE INTO `staff_roles` (`account_id`, `role`, `notes`)
SELECT `id`,
  CASE
    WHEN `vip_level` >= 30 THEN 'owner'
    WHEN `vip_level` >= 20 THEN 'admin'
    WHEN `vip_level` >= 10 THEN 'moderator'
  END AS role,
  CONCAT('Migrado automaticamente de vip_level=', `vip_level`, ' em ', NOW()) AS notes
FROM `accounts`
WHERE `vip_level` >= 10;

-- After confirming the migration above, reset vip_level to 0 on staff accounts
-- (permanently separating commercial VIP from administrative power).
-- UNCOMMENT after verifying the staff_roles migration succeeded:
-- UPDATE `accounts` SET `vip_level` = 0 WHERE `vip_level` >= 10;

-- -----------------------------------------------------------------------------
-- 4. LEDGER: Auditable transaction tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `inventory_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY,
  `character_id`     INT          NOT NULL,
  `base_id`          INT          NOT NULL,
  `delta`            INT          NOT NULL,
  `reason`           VARCHAR(64)  NOT NULL,
  `module`           VARCHAR(32)  NOT NULL,
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE,
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_inv_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_inv_tx_char_date` (`character_id`, `created_at`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `gold_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY,
  `character_id`     INT          NOT NULL,
  `delta`            INT          NOT NULL,
  `reason`           VARCHAR(64)  NOT NULL,
  `module`           VARCHAR(32)  NOT NULL,
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE,
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_gold_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_gold_tx_char_date` (`character_id`, `created_at`)
) ENGINE=InnoDB;

-- =============================================================================
-- END OF MIGRATION v2
-- =============================================================================
