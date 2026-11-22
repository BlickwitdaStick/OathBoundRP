# SkyAdmin — documentation hub

This directory is the entry point for building the administrative and staff panel of SkyMP Heavy RP. It does not replace the existing documentation: it organizes the decisions and points to the source of truth for each topic.

> **Read first: [`../research/ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md) (2026-08-13).**
> This directory describes **intent**; the audit measured the **state**. Its §7 reconciles milestone by milestone — of the six milestones in the [plan](IMPLEMENTATION_PLAN.md), only Milestone 1 has a verifiable deliverable. The only statement in this directory that describes the present is the "Current state" list just below.
> The audit's follow-ups live in [`../admin/`](../admin/ADMIN_PLATFORM.md) and in [ADR 005](../technical/ADR_005_ADMIN_RBAC.md), which decides the RBAC for Milestone 2.

## Current state

- Base: `apps/web` (Express), `apps/game-api`, `apps/bot-discord`, `apps/launcher`, `skymp/gamemode` and MariaDB.
- Online identity: `Discord -> accounts.id -> game session -> SkyMP profileId -> character/actor`.
- Milestone AUTH-003 complete: `whitelist.js` resolves `profileId` as `accounts.id`, not as a Discord ID.
- There is still no granular RBAC in the panel, unified action pipeline, remote Agent, persistent bans or complete operations interface.

## Reading order

1. [PROJECT_CHARTER.md](PROJECT_CHARTER.md) — scope, goal and limits.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — target architecture and contracts.
3. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — milestones, deliverables and acceptance criteria.
4. [SECURITY_MODEL.md](SECURITY_MODEL.md) — threats, controls and non-negotiable rules.
5. [OPERATIONS_AND_TESTING.md](OPERATIONS_AND_TESTING.md) — execution, migration, tests and staging.
6. [REFERENCE_CATALOG.md](REFERENCE_CATALOG.md) — external references, study and permitted reverse engineering.
7. [DECISIONS.md](DECISIONS.md) — current architectural decisions.

## Existing sources that remain canonical

| Topic | Document or code |
|---|---|
| Server overview | [../ARCHITECTURE.md](../ARCHITECTURE.md) |
| Identity and session | [../technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md](../technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md), [../technical/ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md](../technical/ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md) |
| Trust boundaries | [../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md](../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md) |
| SkyMP operations | [../technical/OPERATIONS.md](../technical/OPERATIONS.md), [../technical/SKYMP_SERVER_SETUP.md](../technical/SKYMP_SERVER_SETUP.md) |
| Whitelist criteria | [../staff/WHITELIST_RUBRIC.md](../staff/WHITELIST_RUBRIC.md) |
| Migrations and schema | `skymp/packages/database/schema.sql` and all available migrations (currently `v2`–`v28`) |
| Server rules | [../rules/HEAVY_RP_RULES.md](../rules/HEAVY_RP_RULES.md) |

## Convention

Every change to administrative behavior must update, at minimum: the API contract, the required permission, the effect on the database/game, auditing, an automated test, and this index when it changes the architecture.
