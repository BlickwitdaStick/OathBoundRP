-- =============================================================================
-- Migration v6 - Launch tickets (launcher queue)
-- Apply after migration-v5-character-application.sql.
--
-- Before this table, the launcher joined the queue by sending its own
-- `discordId` as if it were proof of identity. `discordId` is public:
-- anyone who knew another player's Discord could join the queue in their
-- place. Since the queue service (apps/game-api) did not exist yet, this
-- never actually ran — the table exists so that the service is born with
-- real authentication.
--
-- Flow:
--   1. The launcher captures the Discord `code` and sends it to the panel
--      (POST /api/launcher/oauth/exchange).
--   2. The panel — which holds the client secret and is therefore the only one
--      that can prove that Discord account really authenticated — stores a ticket
--      here and returns it to the launcher.
--   3. The launcher presents the ticket to the queue (POST /api/queue/join).
--   4. apps/game-api validates it against this table, sets `consumed_at` and only
--      then returns a session ticket for the game.
--
-- The ticket is single-use and short-lived on purpose: it only needs to survive
-- from the click on "Play" until the queue entry.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `launch_tickets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  -- SHA-256 of the ticket, never the ticket in clear text: if this database leaks,
  -- tickets in flight do not become usable credentials.
  `token_hash` CHAR(64) NOT NULL,
  `account_id` INT NOT NULL,
  `discord_id` VARCHAR(64) NOT NULL,
  `issued_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `consumed_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Set on first use - a replay fails',
  `issued_ip` VARCHAR(64) DEFAULT NULL,
  UNIQUE KEY `uq_launch_ticket_hash` (`token_hash`),
  KEY `idx_launch_ticket_expiry` (`expires_at`),
  CONSTRAINT `fk_launch_ticket_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
