-- v20 — Depot Service: regional item storage
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why "regional" reuses `holds` instead of creating `regions`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `holds` already exists (`schema.sql`) with `id VARCHAR(32)` covering exactly the
-- cities this feature needs (whiterun, solitude, riften...). A loose
-- `region_id` would duplicate a catalog that is already the authority in
-- `core/economy-service.js` (holder `hold`, treasury) and in `market_prices`.
-- `character_depots.hold_id` is an FK to it — there is no second list of
-- "which regions exist" in this database.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why there is NO gold column here
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The original brief asked for "global bank gold" in the Depot. `characters.gold`
-- is already global by nature (there is no concept of "gold in hand" vs "gold in
-- the bank" in this project — see `core/economy-service.js`). Creating a second
-- balance column here would duplicate the single source of truth that
-- `ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md` exists to avoid. The Depot only
-- DISPLAYS the existing balance; it does not keep its own.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `depot_terminals` — why it is a table separate from `character_depots`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `character_depots` is per (character, hold) — someone's storage.
-- `depot_terminals` is per (physical world object) — the chest staff places
-- in a city. Several cities can have different chests (or one city can
-- have more than one), but every Whiterun chest resolves to the SAME
-- `hold_id` = 'whiterun'. Without this table, the Interaction Framework's
-- `DEPOT_CHEST` would have no way to translate "the player interacted with THIS
-- `MpObjectReference`" into "which hold is this".
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Explicit COLLATE on all three tables (2026-08-22)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `holds.id` (schema.sql) does not declare its own COLLATE: it inherits
-- `utf8mb4_unicode_ci` from `CREATE DATABASE ... COLLATE utf8mb4_unicode_ci`
-- (schema.sql line 3). But `DEFAULT CHARSET=utf8mb4` WITHOUT an explicit `COLLATE`
-- in a CREATE TABLE does not inherit the database collation — it uses the SERVER
-- DEFAULT collation for that charset. On MariaDB installs where the `utf8mb4`
-- default changed (e.g. `utf8mb4_uca1400_ai_ci` in versions 10.10+/11.x, instead
-- of the old `utf8mb4_general_ci`), `hold_id VARCHAR(32)` was born with a
-- different collation from the `holds.id` it references — and the FK failed at
-- table creation. The migration had never been tested against a MariaDB install
-- with that default; found while helping an external fork run this for the
-- first time.
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `character_depots` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,

  -- FK to `holds.id` — see the note above. No catalog of its own.
  `hold_id`        VARCHAR(32) NOT NULL,

  `capacity`       INT NOT NULL COMMENT 'Ceiling of summed items in this depot; see server-options depot.defaultCapacity',
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- One depot per character per region — Whiterun items have no way to
  -- show up in Solitude because they are different ROWS, not a filter.
  UNIQUE KEY `uk_depot_character_hold` (`character_id`, `hold_id`),

  CONSTRAINT `fk_depot_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_depot_hold`      FOREIGN KEY (`hold_id`)      REFERENCES `holds` (`id`)      ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `depot_inventory` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `depot_id`   INT NOT NULL,
  `base_id`    INT NOT NULL COMMENT 'Native Skyrim FormID (decimal)',
  `count`      INT NOT NULL DEFAULT 1,

  -- Explicit request from the brief: `container_inventory`/`character_inventory`
  -- do not have this UNIQUE (they rely only on the `FOR UPDATE` of
  -- `transaction-service.tx.applyStackDelta` to avoid fragmenting). Here it comes in
  -- as extra defense in depth, without changing the behavior of the other
  -- two stack tables.
  UNIQUE KEY `uk_depot_inventory_item` (`depot_id`, `base_id`),

  CONSTRAINT `fk_depot_inventory_depot` FOREIGN KEY (`depot_id`) REFERENCES `character_depots` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `depot_terminals` (
  -- FormDesc of the MpObjectReference in the world — hex WITHOUT the `0x` prefix, colon,
  -- plugin name (`"162e2:Skyrim.esm"`), same format as `containers.object_id`.
  `object_id`  VARCHAR(64) PRIMARY KEY,
  `hold_id`    VARCHAR(32) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT `fk_depot_terminal_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `character_depots`
  ADD INDEX IF NOT EXISTS `idx_depot_character` (`character_id`),
  ADD INDEX IF NOT EXISTS `idx_depot_hold`      (`hold_id`);

ALTER TABLE `depot_inventory`
  ADD INDEX IF NOT EXISTS `idx_depot_inventory_depot` (`depot_id`);

ALTER TABLE `depot_terminals`
  ADD INDEX IF NOT EXISTS `idx_depot_terminal_hold` (`hold_id`);
