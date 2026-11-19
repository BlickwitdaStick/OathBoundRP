# Closed alpha runbook

This document turns F9 into a verifiable operation. Fields between `< >`
must be filled in by a person before the window; a missing owner
is `NO-GO`, not an implicit value.

**Baseline revalidated on 2026-08-26:** linear migrations up to v29; Public Work
remains LAB and only enters the window after receiving real routes/FormDescs.

## Window sheet

| Field | Value |
|---|---|
| start/end | `<date and timezone>` |
| release/commit | `<SHA>` |
| incident commander | `<name and contact>` |
| infrastructure operator | `<name and contact>` |
| game/economy owner | `<name and contact>` |
| incident channel | `<channel>` |
| maintenance window | `<time>` |
| pre-release backup | `<file + SHA-256>` |
| previous release for rollback | `<tag/SHA>` |

## Gate before inviting players

- [ ] domain/HTTPS, Discord OAuth and production secrets configured;
- [ ] healthy staging MariaDB, migrations up to v29 and clean schema drift;
- [ ] restorable backup created and rollback rehearsed;
- [ ] signed launcher, valid timestamp and clean Windows install approved;
- [ ] two clients complete login, selection, reconnection and CEF UI;
- [ ] physical FormDescs, Public Work routes and the modpack's Blacksmith recipe confirmed;
- [ ] observability accessible and soak runner started;
- [ ] owners and channel above filled in.

Any empty box requires an explicit risk decision. Security, data loss,
backup, authentication or signing cannot be waived informally.

## Two-week routine

Daily: review health, login failures, connections, rejections, CPU/memory,
DB errors and incidents; confirm the backup; record the deployed change. Twice
a week: reconcile gold and items, review inflation/production per hour and
sample trade, depot, stall and contracts. Every change uses a changelog, SHA,
backup and rollback plan.

Incidents use severity:

| Level | Example | Response |
|---|---|---|
| SEV-1 | loss/duplication, leak, corruption | stop the alpha and roll back |
| SEV-2 | login unavailable, repeated crash | freeze entries and mitigate |
| SEV-3 | isolated feature broken | disable the module and monitor |
| SEV-4 | visual/text with no impact | record for the next window |

## Opening decision

At the end, record a single signed decision:

- `GO`: all mandatory gates and two weeks without data loss;
- `GO WITH RESTRICTIONS`: only non-critical limitations, with an owner and deadline;
- `NO-GO`: any missing critical evidence, an open SEV-1 or a failed data,
  security, authentication, rollback or signing gate.

The minutes must include participants, period, unique players, player-hours,
incidents by severity, soak report, economic reconciliation, accepted
risks, owners and the next review.
