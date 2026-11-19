# Readiness assessment — 2026-08-24

> **Revalidated locally on 2026-08-26.** The NO-GO decision stands. The
> gamemode now has 1,262 tests, all passing,
> migration v29 and 80 declared tables. MariaDB and real clients remain
> unavailable; therefore no promotion gate has been closed.

## Current decision: NO-GO for production/public alpha

The repository has a strong automated foundation and the work possible without
MariaDB has been done, but there is not enough evidence to promote the
system. This decision is based on the gates, not on a perception of polish.

## Mandatory external blockers

| Blocker | Evidence needed to close it |
|---|---|
| MariaDB/staging unavailable | migrations up to v29 applied, clean schema drift, concurrency and restart |
| real Skyrim clients | two clients for 30 min; CEF, `[E]`, Papyrus and reconnection |
| physical content | FormDescs for node/depot/stations and the Blacksmith recipe confirmed |
| distribution | second clean install, manifest and launcher end to end |
| signing | installer with a valid signature/timestamp and SmartScreen registered |
| operations | owners, channel, window, backup and an exercised rollback |
| capacity | 6–8h soak with 5–10 players and a report |
| alpha | two weeks with 10–20 invitees and no data loss |

## Pending product decision

F6-003 must not be implemented by guesswork: "rank accesses a rare resource" in
the Depot could mean capacity, deposit, withdrawal, tab or institutional
stock. Blocking withdrawal of the rare ore would prevent cooperation with the
Smelter. The product owner needs to define the rule and the authorized actors.

## Available automated evidence

- gamemode: 1,262 tests, all passing, and a clean typecheck;
- migration dry-run: 27 files, 162 statements, up to v29;
- declared schema: 80 tables;
- registry: 76 tests listed, no orphans;
- write guards: no known traps;
- soak runner: unit tests and JSON report, waiting for staging;
- backup, restore, rollback, staging and configuration auditor already versioned.
- launcher: fail-closed bootstrap covered by 15 new tests, suite 85/85,
  typecheck/lint passing and NSIS installer generated; handshake with two clients
  still pending as per
  [`ADR-012`](../technical/ADR_012_LAUNCHER_CONNECTION_BOOTSTRAP.md).

The living execution document remains
[`PRODUCTION_READINESS_ACTION_PLAN.md`](../roadmap/PRODUCTION_READINESS_ACTION_PLAN.md).
The next operator should start with the blockers above, not reopen tasks already
completed in code without an observed regression.
