# Rollback runbook

This procedure must be exercised in staging before the alpha. Writing it down
reduces improvisation; it does not prove that it works in the real environment.

## 1. Trigger criteria

- login/entry fails for valid users after a deploy;
- corruption, loss or duplication of state;
- schema drift after a migration;
- the launcher/modpack rejects valid installs en masse;
- a crash loop or degradation that cannot be mitigated by a flag.

Before changing anything, record the time, commit, versions, symptoms and
a backup. Do not delete logs or the faulty volume.

## 2. Service and gamemode code

1. Stop player entry and the services that write to the database.
2. Run `Backup-Staging.ps1` even if the database looks healthy.
3. Identify the last approved commit/release; do not use `git reset --hard`.
4. Create a rollback branch from the approved commit or revert the
   faulty commits with `git revert`.
5. Run the database-free suites and `docker compose config`.
6. Bring up the Node services, check `/health`, then start SkyMP on the host.
7. Log in with a test account before reopening entry.

Module flags are the first mitigation when they isolate the defect without violating
the schema/contract. Every changed flag goes into the incident record.

## 3. Database

Migrations are **forward-only**; there is no automatic downgrade. If the change
is compatible, revert only the code and keep the new columns/tables. If there was
a destructive mutation or invalid data:

1. keep the panel, Game API, bot and SkyMP stopped;
2. keep a separate post-incident dump;
3. choose the pre-deploy backup and check its SHA-256;
4. run `Restore-Staging.ps1`;
5. require a green `check:schema:env -- --strict`;
6. validate a test account/character/transactions before traffic.

Never improvise `DROP`, `TRUNCATE` or a corrective UPDATE on the official database without
a dump, a reviewed query and an audit record.

## 4. Launcher, client and modpack

1. Stop promoting the faulty release; do not delete the artifact used by those who
   already installed it.
2. Restore the last approved `clientVersion`, URL and SHA-256 in the manifest.
3. Restore the mods manifest generated from the known `Data` and its load order.
4. Publish a new corrective release; do not replace bytes under the same version.
5. Test update/repair on a clean install and on a divergent install.

The launcher fails closed on an invalid manifest; a rollback without the correct SHA-256
is an outage, not a rollback.

## 5. Mandatory evidence from the exercise

- date, operator and duration;
- source and destination commit/release;
- backup and SHA-256;
- output of health checks and schema drift;
- result of login, reconnection and character read;
- divergences found and the update of this runbook.

F2-003/F8-003 remain partial until this exercise happens with MariaDB and
staging active.
