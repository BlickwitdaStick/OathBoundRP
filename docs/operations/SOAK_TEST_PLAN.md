# Soak test plan

State revalidated on 2026-08-26: **runner ready; the 6–8 hour run is
blocked by staging/MariaDB, real physical routes and 5–10 real players**.

## Goal and acceptance

The session lasts at least 6 hours, with 5–10 players connected through the launcher.
It only passes when:

- no item or gold is lost/duplicated;
- no process restarts without explanation;
- the health check error rate stays at or below 1%;
- login, reconnection, chat, interaction, trade, depot, mining, crafting, Public
  Work (if enabled in the window), crime and rescue each have at least one recorded run;
- a pre-test backup exists and an owner is tracking incidents;
- the JSON report, gamemode telemetry and service logs are preserved.

The HTTP runner measures availability; it **does not simulate a Skyrim player**, the database,
CEF, Papyrus, inventory or InnoDB concurrency.

## Preparation

1. Fill in the owners and the window in
   [`CLOSED_ALPHA_RUNBOOK.md`](CLOSED_ALPHA_RUNBOOK.md).
2. Bring up staging and apply migrations up to v29 on an empty database.
3. Run `check:schema` and create a backup with `Backup-Staging.ps1`.
4. Confirm the manifest, launcher, UI, FormDescs for nodes/stations/Public
   Work routes and two accounts.
5. Open the incident channel and synchronize the machines' clocks.

## Automated collection

On the staging host, with the three services exposed only on loopback:

```powershell
node scripts/run-service-soak.js `
  --url http://127.0.0.1:3001/health `
  --url http://127.0.0.1:7758/health `
  --url http://127.0.0.1:3002/health `
  --duration-seconds 21600 `
  --workers 5 `
  --interval-ms 1000 `
  --timeout-ms 5000 `
  --max-error-rate 0.01 `
  --output reports/soak-alpha.json
```

For 8 hours, use `--duration-seconds 28800`. The output file is created in
exclusive mode: an existing report is never overwritten. The process returns
`0` when every URL stays within the limit, `2` when the gate fails and `1`
for an invalid configuration.

## Hourly human script

| Moment | Minimum action |
|---|---|
| start | login through the launcher, same cell, chat and panel |
| hour 1 | mining → depot → smelting/crafting |
| hour 2 | concurrent trade and stall |
| hour 3 | crime, search, confiscation and restitution |
| hour 4 | downed, rescue, disconnection and reconnection |
| hour 5 | contracts, economy and review of the counters |
| end | clean logout, balances, inventories, backup and log collection |

Each incident records the time, players, action, expected result, observed
result, requestId when visible, severity, mitigation and a link to the logs.

## Stop criteria

Stop and start a rollback if there is duplication/loss, widespread authentication
unavailability, schema corruption, a secret in a log, a crash loop
or the inability to reconstruct a transfer. An isolated cosmetic error
may continue if it has an owner and does not compromise data.

## Closing

Attach the runner's JSON, the commit SHA, the final migration, the number of players,
duration, incidents and economic reconciliation to the readiness plan. Without these
artifacts, F8-005 remains partial regardless of whether the session "looked good".
