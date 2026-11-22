-- =============================================================================
-- Migration v26 - Persistent web panel sessions
-- Apply after migration-v25-launcher-sessions.sql.
--
-- Replaces the express-session MemoryStore. The cookie still only contains the
-- signed opaque identifier; authentication state lives in MariaDB and
-- survives a panel restart or an instance switch.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `web_sessions` (
  `session_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `data_json` LONGTEXT NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`session_id`),
  KEY `idx_web_sessions_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
