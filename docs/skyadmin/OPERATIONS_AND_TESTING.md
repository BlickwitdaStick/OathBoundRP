# Operations and testing

## Environments

| Environment | Purpose | Rules |
|---|---|---|
| Local | development and lab | auto-whitelist only with an explicit flag; disposable data |
| Staging | release rehearsal | `offlineMode=false`, its own secrets, TLS and an isolated database |
| Production | real players | backups, monitoring, minimal access and traceable changes |

## Current verification commands

```powershell
Set-Location skymp/gamemode
npm test
npm run typecheck
```

The other packages have their own suites. Before changing a contract between components, also run the tests of `apps/web`, `apps/game-api`, `apps/bot-discord` and `apps/launcher`.

## Migrations

- Never edit a migration that has already been applied.
- A new schema change gets a new versioned migration in `skymp/packages/database/`.
- Apply the base schema and migrations in numeric order.
- Run `npm run check:schema:list` in the gamemode to validate the inventory; the real check requires a configured database.
- Backups and restores must be rehearsed in staging before any destructive change.

## Administrative incident runbook

1. Pause the affected action; do not edit rows manually.
2. Look up `request_id`, `action_id`, the target account and correlated logs.
3. Confirm the state in the database and in the Agent/SkyMP.
4. Revoke the session or apply minimal containment if there is an active risk.
5. Record the cause, the fix and a regression test.

## Staging criteria

- Discord login and the queue work with a valid ticket.
- An expired/revoked session returns a login failure.
- An approved whitelist gets in; an inactive or banned account does not.
- Rate limit, CSRF and permission checks refuse correctly.
- The audit contains actor, target, action and result.
