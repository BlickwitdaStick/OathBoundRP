-- =============================================================================
-- Migration v8 - Game sessions (master API)
-- Apply after migration-v7-indexes.sql.
--
-- Closes the loose end in identity: until now, `whitelist.js` derived who the
-- player was from the `profileId` the client itself reported in
-- `skymp_config.json`. Anyone could edit the file and become someone else.
--
-- SkyMP already solves this natively, and we did not know (see
-- skymp5-server/ts/systems/login.ts). With `offlineMode: false`, the server does
-- NOT trust the client: it takes the `gameData.session` the client sent and
-- resolves it against a "master API":
--
--   GET {master}/api/servers/{masterKey}/sessions/{session}
--     -> { user: { id: number, discordId: string } }
--
-- The `id` returned there becomes the `profileId`. Since `master` is just a string
-- in `server-settings.json`, our own panel can be that master — and it already
-- is what authenticates Discord and approves the whitelist.
--
-- This table is what the panel queries to answer. Unlike
-- `launch_tickets` (single use, 5 min TTL, spent on queue entry), a
-- game session:
--   - can be resolved more than once, because the server queries on every
--     connection and a player who drops from a crash needs to reconnect;
--   - lasts long enough for a play session, not for a click.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `game_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  -- SHA-256 of the token, never the token in clear text: if the database leaks,
  -- sessions in flight do not become usable credentials. Same rule as `launch_tickets`.
  `token_hash` CHAR(64) NOT NULL,
  `account_id` INT NOT NULL,
  `discord_id` VARCHAR(64) NOT NULL,
  `issued_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `last_resolved_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Last time the game server resolved this session',
  `resolve_count` INT NOT NULL DEFAULT 0 COMMENT 'How many times it was resolved - useful to detect a shared session',
  `revoked_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Set on ban/kick without waiting for the TTL',
  UNIQUE KEY `uq_game_session_hash` (`token_hash`),
  KEY `idx_game_session_account` (`account_id`, `expires_at`),
  KEY `idx_game_session_expiry` (`expires_at`),
  CONSTRAINT `fk_game_session_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
