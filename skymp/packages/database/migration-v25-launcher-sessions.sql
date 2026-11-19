-- =============================================================================
-- Migration v25 - Launcher sessions (new ticket without redoing OAuth)
-- Apply after migration-v24-crafted-item-signatures.sql.
--
-- Problem this solves: `launch_tickets` (v6) is single-use on purpose
-- — it only survives from the click on "Play" until the queue entry. That is correct
-- for the ticket itself, but it left a gap: when the queue admits immediately
-- (`status: 'success'`), the server does not issue a replacement ticket (only
-- `status: 'queued'` gets a `pollTicket`), so a second attempt to
-- play in the same launcher session resent the already-consumed ticket and hit
-- `401 invalid_ticket` — the player could only get a new ticket by redoing the
-- whole Discord OAuth (popup, redirect, everything again).
--
-- This table stores a launcher session: multi-use (unlike the
-- launch_ticket), longer-lived, and good for ONE thing only — requesting a
-- new launch_ticket. It does not replace the eligibility check (whitelist,
-- ban), which still happens in apps/game-api at queue time; it only
-- Recipe names are player-facing; migration-v31-english-seed-labels.sql renames old rows.
-- `launch_tickets` ja provava, so que reutilizavel.
--
-- Flow:
--   1. POST /api/launcher/oauth/exchange (v6) now also issues a
--      `sessionToken` alongside the `launchTicket`, when the account exists.
--   2. The launcher stores both. Before each attempt to join the queue,
--      it trades the `sessionToken` for a fresh `launchTicket` at
--      POST /api/launcher/session/refresh-ticket — no popup, no Discord.
--   3. POST /api/launcher/session/revoke deletes the session on logout, so an
--      auth.json file stolen from disk stops working after its owner
--      logged out.
--
-- 30 days and not "forever": the periodic re-OAuth is the only point where
-- we confirm again, directly with Discord, that the account still exists and was not
-- deleted/banned on their side — useful enough not to give it up.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `launcher_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  -- SHA-256 of the token, never the token in clear text — same reasoning as
  -- `launch_tickets.token_hash`.
  `session_hash` CHAR(64) NOT NULL,
  `account_id` INT NOT NULL,
  `discord_id` VARCHAR(64) NOT NULL,
  `issued_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  `revoked_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Set on logout or manual revocation',
  `issued_ip` VARCHAR(64) DEFAULT NULL,
  UNIQUE KEY `uq_launcher_session_hash` (`session_hash`),
  KEY `idx_launcher_session_expiry` (`expires_at`),
  KEY `idx_launcher_session_account` (`account_id`),
  CONSTRAINT `fk_launcher_session_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
