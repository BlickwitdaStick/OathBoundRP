# Implementation plan

## Milestone 0 — foundation and tests

- Inventory existing routes, tables, permissions and flows.
- Keep a suite that runs without an external server.
- Criterion: web, game-api, bot, launcher and gamemode tests documented and reproducible.

## Milestone 1 — identity and migrations

- [x] Define `profileId online === accountId`.
- [x] Fix the whitelist to query `accounts.id`.
- [ ] Formalize a single migrations runner and drift check.
- [ ] Cover login, expired session, reconnection and revocation with MariaDB integration tests.

## Milestone 2 — RBAC in the database

- Create `staff_roles`, `staff_permissions`, `staff_role_permissions`, `staff_memberships` and overrides only where needed.
- Replace the generic `requireStaff` gate with `requirePermission(permission)`.
- Record every denial and permission change.
- Criterion: permission matrix tested for every administrative route.

## Milestone 3 — action pipeline and audit v2

- Create an action catalog and validated JSON schemas.
- Create `admin_actions`, `admin_action_attempts`, `admin_action_outbox` and `admin_action_results`.
- Implement idempotency, mandatory reason, correlation and transactional outbox.
- Criterion: retries do not duplicate effects and failures are visible in the history.

## Milestone 4 — moderation and in-game enforcement

- Implement notes, warnings, persistent ban, session revocation and kick.
- Create a minimal SkyAdmin Agent/bridge for online status and kick.
- Criterion: a ban prevents login; a kick affects only the target; both actions are audited.

## Milestone 5 — operations interface

- List and search players/accounts/characters.
- Player profile with timeline, notes, session history and moderation.
- Whitelist and staff manager on top of protected APIs.
- Criterion: no sensitive action is a generic database CRUD.

## Milestone 6 — security and staging

- MariaDB session, CSRF, CSP, persistent rate limits where needed and structured logs.
- Staging with TLS, external secrets and tested backup/restore.
- Criterion: security checklist approved before production.

## Immediate work order

1. Central documentation and migrations runner.
2. RBAC model and migrations.
3. Permission middleware and web tests.
