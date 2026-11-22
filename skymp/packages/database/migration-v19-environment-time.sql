-- v19 — world_time_state: the server's authoritative clock
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why a ONE-row table, and not a generic KV
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `environment-service.js` (Time Sync) needs to survive a restart without the
-- world "going back in time": the process's in-memory clock is the ONLY
-- authority while the server is up (it never reads the database again to
-- decide the next value), and the database only exists so the next boot knows
-- where to resume. That calls for exactly one row, not a history — recording
-- every tick would create a table that grows forever with no consumer
-- of the history (the same "evaluate the real need before creating a
-- table" reasoning migration v18 applied to the profession catalog).
--
-- `CHECK (id = 1)` closes the door on a second row showing up by mistake —
-- an INSERT with a different id fails loudly, instead of the server silently
-- starting to read/write the wrong row.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- What this migration does NOT create
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No weather column. `docs/technical/ENVIRONMENT_WEATHER_SPIKE.md`
-- documents why: there is no confirmed Weather/ForceWeather binding in the
-- SkyMP API (`skymp/gamemode/types/mp.d.ts`), and
-- `docs/MODDING_GUIDELINES.md` itself already records the smooth-transition question as
-- open. Persisting weather state before confirming the server
-- can really FORCE weather would be persisting a field nothing reads.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `world_time_state` (
  -- Single row locked to 1 by the CHECK below — see the decision note above.
  `id`                INT NOT NULL DEFAULT 1,

  -- Game days elapsed since the server epoch (double, not int: the
  -- clock advances by fractions of a day each tick, and truncating here would have
  -- the same practical effect as losing time on every persist).
  `game_days_passed`  DOUBLE NOT NULL DEFAULT 0,

  -- Game time speed relative to real time. 20 is Skyrim's vanilla
  -- default (1 real hour ~= 20 game hours); configurable via
  -- INITIAL_TIMESCALE at boot, but only in this row after the first boot —
  -- restarting the server does NOT reset to the .env value, it resumes from here.
  `timescale`         FLOAT NOT NULL DEFAULT 20,

  `updated_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  CONSTRAINT `chk_world_time_single_row` CHECK (`id` = 1)
-- No FK here at all, so no risk today. If a VARCHAR FK is
-- added against a table with an explicit COLLATE (e.g. `holds`), it will
-- break the same way migration-v20-depot-service.sql broke — see the
-- comment there. Declare COLLATE=utf8mb4_unicode_ci explicitly if it happens.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
