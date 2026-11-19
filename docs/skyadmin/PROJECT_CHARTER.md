# SkyAdmin Project

## Goal

Turn the existing web panel into a secure administrative surface for whitelist, player management, staff, moderation, auditing and operations of the SkyMP server.

## Initial scope

- Discord login and persistent web session.
- Granular, database-backed RBAC, deny by default.
- Lookup of players, accounts, characters, whitelist and history.
- Moderated actions: approve/reject whitelist, notes, warn, kick, ban and session revocation.
- Immutable audit of administrative actions.
- Transactional action queue and, later, a bridge to the SkyMP process.

## Out of initial scope

- Generic SQL panel or direct table editing.
- Arbitrary shell/console execution from the browser.
- Replacing SkyMP, txAdmin, GameAP or Pterodactyl.
- Mandatory Redis, BullMQ, microservices and containers.
- Dangerous in-game actions before an authenticated, idempotent bridge exists.

## Principles

1. MariaDB is the source of truth.
2. The browser requests an action; it never chooses how it is executed.
3. Every mutation has an actor, target, reason, permission, `request_id`, result and audit entry.
4. Game identity comes from the Master API, never from an ID declared by the client.
5. Fail closed for authorization and destructive actions.
6. The panel evolves inside `apps/web`; no second, parallel product will be created.

## Indicators of readiness for staff use

- Staff without permission can neither infer nor execute a privileged action.
- Repeating a request does not duplicate its effect.
- A failed action leaves a queryable result and reason.
- Ban and logout revoke the applicable game sessions.
- Every administrative route has an authorization and audit test.
