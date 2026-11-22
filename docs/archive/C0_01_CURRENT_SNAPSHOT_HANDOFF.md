# C0-01 — Current snapshot and handoff

Date: 2026-08-12. Branch: `fix/voip-proximidade-por-celula`. Base commit: `112d51bc4f1e4308aebe3ab40881abe328db188e`.

> **Historical record, superseded:** the snapshot described below was consolidated in commit `c23179d` and published to `main`. The mentions of a dirty tree, temporary ownership and base commit describe the moment of the handoff, not the current state of the repository. The gamemode suite later reached 547 passing tests.

## Preserved scope

The tree was already modified before AUTH-001 started. This snapshot contains work on the UI gateway/rate limit, connection lifecycle, transactional economy, market stall idempotency, VOIP and documentation. None of these files was reverted or reformatted during this step.

Main groups:

- `core/ui-event-*`, governance and player panel: CEF contract and progressive validation.
- `core/connection-monitor*`: connection polling protected against stale asynchronous responses.
- `core/institutional-treasury-service*`, `core/regional-market-transaction-service*`, migrations v11-v13: transactions and idempotency.
- `voip-service*`: protocol limit, sender/listener roles and per-cell separation.
- `docs/roadmap/TASK_001` to `TASK_006`: status and tests of each deliverable.

## Snapshot verification

| Check | Result |
|---|---|
| Gamemode `npm test` | 531/531 |
| Gamemode `npm run typecheck` | passed |
| Web | 40/40 |
| Game API | 30/30 |
| Discord bot | 40/40 |
| Launcher | 24/24 |
| `git diff --check` on the audit documents | passed |

There was no in-game test in this step. The previous handoff states that the local schema had been checked, but C0-01 neither reapplied migrations nor changed the database.

## Files Claude must not edit without a new handoff

- `skymp/gamemode/phase0-basic.js`
- `skymp/gamemode/core/character-state.js`
- `skymp/gamemode/core/connection-monitor.js`
- `skymp/gamemode/core/ui-event-*`
- `skymp/gamemode/voip-service.js`
- `skymp/gamemode/governance-service.js`
- `skymp/gamemode/market-stalls-service.js`
- `skymp/packages/database/schema.sql` and migrations v11-v13

Ownership released to Claude on Thursday: `apps/game-api/`, `apps/launcher/`, distribution documentation and the release workflow, after it confirms the base commit and its own `git status`.

## Known risks

- **At the time of this handoff**, the tree was dirty and did not yet have a consolidation commit; this risk was closed by commit `c23179d`.
- The launcher writes a Discord-derived `profileId` in addition to the opaque session. In production, `offlineMode=false` makes SkyMP use the Master API, but the redundancy becomes a bypass if the configuration regresses.
- The names ticket/session are ambiguous across web, queue, launcher and SkyMP.
- The most recently approved character is chosen implicitly; there is still no slot selection tied to the session.

## Handoff

```text
Task: C0-01
Implementer: Codex
Base commit: 112d51bc4f1e4308aebe3ab40881abe328db188e
Files changed: only new documentation for this phase
Invariants preserved: PARKED modules off; official MariaDB; local work intact
Tests: 531 + 40 + 30 + 40 + 24 passed; typecheck passed
Manual tests: server/CEF/in-game voice still pending
Security blockers: derived profileId in client settings; offlineMode configuration
Next action: AUTH-001/002 and adversarial review by Claude
```
