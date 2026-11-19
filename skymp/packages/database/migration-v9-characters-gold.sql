-- =============================================================================
-- Migration v9 - Adds characters.gold to databases that came from the old schema
-- Apply after migration-v8-game-sessions.sql.
--
-- Why this migration exists
-- -----------------------------------------------------------------------------
-- `characters.gold` is declared in `schema.sql`, and in NO migration. That
-- works for a new database (run schema.sql and done), and leaves a gap in an
-- old database: whoever created the database before the column entered the schema
-- and then applied v2 -> v8 in order, as CONTRIBUTING says, never gets the column.
--
-- v2 even creates the `gold_transactions` table — the economy ledger — without
-- ensuring the balance column that ledger tracks.
--
-- The effect does not show at boot. It shows on the first gold operation, which is
-- the whole of `core/transaction-service.js`:
--
--     SELECT gold FROM characters WHERE id = ? FOR UPDATE
--     UPDATE characters SET gold = gold + ? WHERE id = ?
--
-- In other words: stall purchases, guard fines, death penalty, starting gold
-- and `/setgold` all fail with "Unknown column 'gold'", in the middle of a scene.
--
-- Found by `npm run check:schema` (QA 4.1) while preparing Phase 0, which is
-- exactly the class of problem that checker was written to catch:
-- "a half-migrated database does not break boot; it breaks the query that touches
-- the missing column, weeks later".
--
-- Idempotent: `IF NOT EXISTS` makes this migration harmless on a database that
-- came from the full `schema.sql` and already has the column.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `characters`
  ADD COLUMN IF NOT EXISTS `gold` INT NOT NULL DEFAULT 0
    COMMENT 'In-game economy (Septims). Every change goes through core/transaction-service.js';
