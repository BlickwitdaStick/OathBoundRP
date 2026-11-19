-- v21 - Crime & Provenance: item instance foundation (Task 12)
--
-- Technical goal: stolen items (or high-value ones, in a future delivery)
-- stop being fungible inside the common stack (`character_inventory.count`)
-- and get their own row in `item_instances`, with a UUID and an ownership
-- history. The common stack remains the source of truth for everything that was never
-- stolen — no item becomes an instance just by existing.
--
-- See core/crime-service.js for who reads and writes these tables.

-- 1. Tracked item instance (UUID)
CREATE TABLE IF NOT EXISTS `item_instances` (
  `id` CHAR(36) NOT NULL PRIMARY KEY COMMENT 'UUID v4 (crypto.randomUUID in crime-service)',
  `base_id` INT NOT NULL COMMENT 'Native Skyrim FormID (decimal), same convention as character_inventory.base_id',
  `original_owner_id` INT NOT NULL COMMENT 'Character that owned it before the first recorded theft; never changes afterwards',
  `current_owner_id` INT NOT NULL COMMENT 'Character carrying the item now',
  `status` VARCHAR(16) NOT NULL DEFAULT 'hot' COMMENT 'hot, stolen, clean -- see crime-service.STATUS',
  `stolen_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Time of the most recent theft; defines the hot window',
  `last_hold_id` VARCHAR(64) DEFAULT NULL COMMENT 'Hold where the most recent theft happened; used by Technical Restitution (Depot-Service) to know where to deposit',
  `provenance_data` JSON DEFAULT NULL COMMENT 'Ownership history: [{ownerId, at, reason}, ...]',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_item_instance_original_owner` FOREIGN KEY (`original_owner_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_item_instance_current_owner` FOREIGN KEY (`current_owner_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_item_instance_current_owner` (`current_owner_id`, `status`),
  INDEX `idx_item_instance_status_stolen_at` (`status`, `stolen_at`)
) ENGINE=InnoDB;

-- 2. Anti-Combat-Log: alert created when a character logs out carrying a
-- 'hot' item. Resolved (`resolved=1`) when the player returns before the grace period, or
-- when Technical Restitution returns the item to its original owner.
CREATE TABLE IF NOT EXISTS `session_crime_alerts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL COMMENT 'Who disconnected carrying the hot item',
  `item_instance_id` CHAR(36) NOT NULL,
  `disconnected_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `resolved` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0=Awaiting return or restitution, 1=Resolved',
  `resolved_at` TIMESTAMP NULL DEFAULT NULL,
  CONSTRAINT `fk_session_alert_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_session_alert_item` FOREIGN KEY (`item_instance_id`) REFERENCES `item_instances` (`id`) ON DELETE CASCADE,
  INDEX `idx_session_alert_pending` (`resolved`, `disconnected_at`)
) ENGINE=InnoDB;

-- 3. `audit_logs` gets the crime flag and the link to the item instance.
-- Every transfer of an instanced item is recorded here with `is_crime=1`
-- (crime-service._recordCrimeAudit), separate from the fungible ledger in
-- `inventory_transactions` (which keeps recording the same two legs of the
-- movement, unaware of provenance).
ALTER TABLE `audit_logs`
  ADD COLUMN `is_crime` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Flags crime-service actions; used to filter the investigation log',
  ADD COLUMN `item_instance_id` CHAR(36) DEFAULT NULL COMMENT 'Links the log to the item instance when applicable',
  ADD CONSTRAINT `fk_audit_item_instance` FOREIGN KEY (`item_instance_id`) REFERENCES `item_instances` (`id`) ON DELETE SET NULL,
  ADD INDEX `idx_audit_is_crime` (`is_crime`);
