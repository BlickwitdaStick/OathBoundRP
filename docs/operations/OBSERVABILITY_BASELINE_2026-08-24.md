# Observability baseline — 2026-08-24

An inventory of what the project can explain today without depending on MariaDB,
Skyrim or external services. This document is the initial evidence for `F8-002`;
it does not declare the gate complete.

## Existing coverage

| Minimum signal | Exists today | Where it appears | Operational gap |
|---|---|---|---|
| Connections | **Yes, local** | `connection-monitor.js` aggregates actives, states, connections, disconnections, approvals and rejections. | The snapshot stays in the process log; a collector/history is missing. |
| Login failures | **Partial** | The Master API records invalid keys and errors; the launcher shows failures to the player. | No total per cause and no launcher→Master API→game-api correlation. |
| DB latency | **Yes, per service** | The shared wrapper measures success/error in fixed buckets in the panel and the Game API. | Still missing a collector/retention and gamemode instrumentation. |
| CEF events | **Yes, local** | `ui-event-rate-limiter.snapshot()` counts observed/rejected per type and the bootstrap publishes JSON every 60 s, without payload. | The metric stays in stdout only and resets with the process. |
| Rejections | **Partial** | Authentication/secret guards and rate limits increment enumerated reasons. | Domain refusals in the gamemode and the queue are still not covered. |
| Transfers | **Partial** | `transaction-service` and `inventory` record success, replay and failure; the durable ledger lives in the database. | No aggregated rate/latency and no failure alert. |
| Reconciliations | **Partial** | Economy/physical-state routines and `healthCheck()` exist. | Runs and divergences are not aggregated. |
| Polling | **Partial** | The connection monitor measures interval, ticks and maximum duration. | Death, panel, interaction and hotkey pollers do not yet measure duration/overlap. |
| CPU and memory | **Yes in the Node services** | Internal snapshots include accumulated CPU, RSS, heap and external memory; SkyMP declares `mp.getPrometheusMetrics()`. | Still missing the gamemode, a collector and history. |
| Queue | **Yes, ephemeral** | The Game API's `GET /health` exposes capacity, occupied, connected and waiting. | No history, alerts or persistence after restart. |
| Module health | **Local** | `module-registry.healthCheckAll()` isolates failures of active modules. | The result is neither published nor tracked. |

## Implementation principles

1. Metrics must not carry a ticket, session token, secret, chat text,
   CEF payload, free-form reason or personal identifier.
2. Internal metrics must not sit on a public endpoint without authentication.
3. Names and labels must have bounded cardinality; never use IP, actorId,
   accountId, a dynamic route or an error message as a label.
4. Logs must keep the component's stable prefix and include an opaque
   `requestId` when an operation crosses services.
5. In-memory metrics serve one instance; production needs a scrape or
   external push to survive a restart.

## Next executable deliverables

### O1 — HTTP instrumentation (`IMPLEMENTED`, no collector)

- [x] counters per service, normalized route and status class;
- [x] duration in fixed buckets;
- [x] counters for rate limit and refused authentication;
- [x] internal endpoint protected by `X-Internal-Secret` in the Game API and the bot;
- [x] staff-only endpoint in the panel;
- [x] `X-Request-Id` validated/generated and propagated from the panel to the bot;
- [ ] collector, retention and alerts.

Endpoints:

- panel: `GET /api/metrics` (session with a staff role);
- Game API: `GET /internal/metrics` (`X-Internal-Secret`);
- bot: `GET /api/metrics` (`X-Internal-Secret`, API bound to `127.0.0.1`).

The snapshot contains no SQL, parameters, IP, accountId, actorId, ticket, token,
CEF payload or free text. Series have bounded cardinality and dynamic routes
use the Express template (`/resource/:id`), never the concrete URL.

### O2 — Database and login flow (`PARTIAL`)

- [x] measure duration and errors in the panel/Game API query wrappers, without recording SQL/params;
- [ ] propagate `requestId` from the launcher to OAuth, the queue and the Master API;
- count failures by enumerated cause (`invalid_ticket`, `not_whitelisted`, etc.).

### O3 — Gamemode and process (`PARTIAL`)

- [x] publish `healthCheckAll()`, CEF events and connections to a structured log, without IDs/free-form errors;
- [x] include process CPU/RSS/heap and the maximum duration of connection polling;
- [ ] measure reconciliations and the other pollers;
- integrate `getPrometheusMetrics()` when it is available in the pinned artifact;
- [ ] export to a collector/retention.

### O4 — Operations

- choose a collector, retention and alerts;
- minimal dashboard for login, queue, DB, CEF, transfers and resources;
- run a controlled incident and prove diagnosis without local reproduction.

`F8-002` can only be completed after O1–O4 and the incident exercise.
