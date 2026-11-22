-- =============================================================================
-- Migration v7 - Indexes for the hottest read queries
-- Apply after migration-v6-launch-tickets.sql.
--
-- These tables only had a primary key and the implicit foreign key indexes.
-- With few rows this does not show; with the server really running, every
-- read becomes a full table scan.
--
-- The governance and stall tables were already well indexed in migrations
-- v3/v4 — the gap is in the older tables (schema.sql) and in the ones the
-- web panel queries.
--
-- All indexes are additive: no column, type or constraint changes, and
-- running it twice is harmless (IF NOT EXISTS).
-- =============================================================================
USE `skymp_rp`;

-- ── audit_logs ───────────────────────────────────────────────────────────────
-- Queried by `GET /api/audit` (ORDER BY created_at DESC LIMIT 200) and by the
-- dashboard. It is the fastest-growing table in the project: every staff action,
-- every death, every combat start and every whitelist approval writes here.
ALTER TABLE `audit_logs`
  ADD INDEX IF NOT EXISTS `idx_audit_created` (`created_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_action_created` (`action`, `created_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_target` (`target_account_id`, `created_at`);

-- ── character_inventory ──────────────────────────────────────────────────────
-- Read on every player spawn (inventory-service.syncInventoryToClient) and in
-- every item transaction. The unique index on (character_id, base_id) also
-- guards against two rows for the same item on the same character, which is
-- the state transaction-service's `FOR UPDATE` assumes does not exist.
ALTER TABLE `character_inventory`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_char_inventory_item` (`character_id`, `base_id`);

-- ── characters ───────────────────────────────────────────────────────────────
-- `whitelist.js` runs this query on every login:
--   SELECT * FROM characters WHERE account_id = ? AND status = 'approved'
--   ORDER BY id DESC LIMIT 1
ALTER TABLE `characters`
  ADD INDEX IF NOT EXISTS `idx_characters_account_status` (`account_id`, `status`);

-- ── whitelist_applications ───────────────────────────────────────────────────
-- Queried at login (approval check) and by the panel (review queue,
-- sorted with pending first).
ALTER TABLE `whitelist_applications`
  ADD INDEX IF NOT EXISTS `idx_whitelist_account_status` (`account_id`, `status`),
  ADD INDEX IF NOT EXISTS `idx_whitelist_status_created` (`status`, `created_at`);

-- ── discord_identities ───────────────────────────────────────────────────────
-- The PK is `discord_id`, but almost every panel JOIN comes in through `account_id`.
ALTER TABLE `discord_identities`
  ADD INDEX IF NOT EXISTS `idx_discord_account` (`account_id`);

-- ── criminal_records / prison_records ────────────────────────────────────────
-- Both queried by status in the staff panel and by governance.
ALTER TABLE `criminal_records`
  ADD INDEX IF NOT EXISTS `idx_criminal_resolved_created` (`resolved`, `created_at`),
  ADD INDEX IF NOT EXISTS `idx_criminal_character` (`character_id`, `resolved`);

ALTER TABLE `prison_records`
  ADD INDEX IF NOT EXISTS `idx_prison_status_arrested` (`status`, `arrested_at`),
  ADD INDEX IF NOT EXISTS `idx_prison_character_status` (`character_id`, `status`);
