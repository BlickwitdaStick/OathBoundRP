# Administrative platform security matrix

**What is locked by tests, what is locked only by convention, and what is not
locked.** The three columns exist because mixing them is how a project comes to think
it is secure.

References: [audit](../research/ADMIN_PLATFORM_AUDIT.md) ·
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md) · [RBAC](../admin/RBAC.md) ·
[moderation](../admin/MODERATION_WORKFLOW.md)

---

## 0. State on 2026-08-13, stated without euphemism

> **None of the tests in this matrix exist.** This document is the gate, not the
> report. It describes what must pass **before** any member of
> staff receives access to the panel — and none of it passes today.

What exists today, so the two are not confused:

| Suite | State | What it covers administratively |
|---|---|---|
| `apps/web/server.test.js` | passes | 12 routes respond **401 without a session**; sheet validation; ticket stores a hash; master API contract |
| `skymp/gamemode/permissions.behavior.test.js` | passes | role × command matrix **of the gamemode**, by real behavior |
| `skymp/gamemode/parked-staff-permissions.test.js` | passes | PARKED commands; no numeric level left |
| `skymp/gamemode/admin-service.test.js` | passes | `hasPermission` refuses an invalid argument; role does not survive disconnection |

And the exact hole: **no panel test exercises an authenticated session.**
They all stop at 401. The path "logged-in staff, without the right permission" — which is the
only path RBAC needs to prove — has never been executed.

---

## 1. The claims the matrix must sustain

Each one becomes a test. None counts as intent.

1. Every administrative route requires **a named permission**, not the existence of
   a role.
2. A role without the permission **never** achieves the effect, and the denial becomes an audit
   row.
3. Repeating the same request does not duplicate the effect.
4. A 🔴 action without a reason is refused **on the server**, not only in the UI.
5. Gold and items moved through the panel go through `transaction-service` and leave
   a row in the ledger.
6. A ban prevents login; session revocation prevents reconnection; neither
   depends on the UI having done the right thing.
7. A staff account that is banned or whose role has expired loses access on the next
   request.

---

## 2. Authorization matrix

### 2.1 Per route

Each administrative route gets **three** tests, not one. The third is the one that
is usually missing.

| # | Test | Expected |
|---|---|---|
| A | no session | `401`, no domain query executed |
| B | staff session **with** the permission | `2xx` and an observable effect |
| C | staff session **without** the permission | `403`, **no effect**, audit row `outcome='denied'` |

Test C checks **absence of effect**, never just the status code. A route
that responds `403` after writing to the database passes a status test and is
exactly the bug the test exists to catch.

Test B checks **effect**, never just `ok:true`. Today's `PATCH /api/whitelist/:id`
responds `ok:true` for a nonexistent application ([audit §4.12](../research/ADMIN_PLATFORM_AUDIT.md)) — proof that status is not evidence.

### 2.2 Per role × permission

A replica of what `permissions.behavior.test.js` already does in the gamemode, applied to the
panel: a `MATRIZ` table in the test file, one case generated per cell, and a
failure message that says *"this is privilege escalation"*.

Mandatory cases beyond the matrix:

| Case | Expected |
|---|---|
| Role **without inheritance**: `MODERATOR` does not get a permission just because `ADMIN` has it | denied |
| Unknown role in `staff_roles` (e.g. `'suporte'` typed by hand) | **`403`, not full access** — today it is full access ([audit §4.3](../research/ADMIN_PLATFORM_AUDIT.md)) |
| Role with `expires_at` in the past | denied |
| Role with `revoked_at` filled in | denied |
| Two active role rows on the same account | union of permissions, both counted |
| `deny` override on a permission the role grants | **denied** — `deny` wins |
| Expired `grant` override | denied |
| Staff account with `accounts.status='banned'` | denied on every route |

### 2.3 Sync between the two sides

The structural defect the audit found is that the panel and the gamemode read the same
table with different rules. The test that prevents recurrence:

| Test | Expected |
|---|---|
| Every permission in `staff_permission_catalog` has at least one checker in the code | fails naming the orphans |
| Every string passed to `requirePermission()` and to `hasPermission()` exists in the catalog | fails naming the invented ones |
| The panel's and the gamemode's permission resolution, for the same account, produce the **same set** | fails on divergence |

The first test fails today: `ban`, `view_audit` and `manage_whitelist` are
declared and no line of code checks them.

---

## 3. Threat matrix — briefing §20

| Threat | State today | What locks it later |
|---|---|---|
| **RBAC bypass** | 🔴 there is nothing to bypass: the gate is binary | test C on every route + §2.2 |
| **Escalation via unknown role** | 🔴 full access | `FK` to `staff_role_definitions` + test |
| **SQL injection** | 🟢 everything parameterized (`pool.execute`) in web, game-api and bot | test that fails if concatenation in SQL appears |
| **Mass assignment** | 🟡 current routes destructure fields explicitly | validation rejecting unknown fields |
| **IDOR** | 🟡 the target comes from the path, but nobody checks whether the resource exists | test: nonexistent id → `404`, never `ok:true` |
| **CSRF** | 🟡 `sameSite:'lax'` already blocks cross-site `PATCH`; no token, no defense in depth | token + test of a mutating route without a token → `403` |
| **XSS** | 🟡 the UI builds HTML through template strings; no CSP | CSP and an escaping test on a sheet field (biography is player text) |
| **Session fixation** | 🔴 the session is not regenerated at login | `req.session.regenerate()` in the callback + id-change test |
| **In-memory session** | 🔴 `MemoryStore`; every session dies on deploy | MariaDB store + restart survival test |
| **OAuth** | 🟢 `redirect_uri` in an allowlist; secret only on the server; ticket with a hash | keep the existing tests; evaluate PKCE (pending in skyadmin) |
| **Exposed internal API** | 🟢 `X-Internal-Secret` in constant time; bot listens on `127.0.0.1` | existing test covers 401 without the secret |
| **WebSocket auth** | 🟡 only the voice one exists; the panel does not use WS | if the bridge uses WS: authenticate at handshake, test rejection |
| **Audit tampering** | 🔴 single SQL user with full DML | §5 |
| **Exposed admin API** | 🟡 `game-api`'s `GET /health` is public (aggregates only, no identity) | keep it aggregated; test that fails if identity leaks |
| **Enumeration via response** | 🟡 `403` does not say which permission was missing (correct); but a generic `ok:true` gets in the way | standardize the error body + test |

---

## 4. Behavior tests — briefing §21

| Requested scenario | Test | What it really verifies |
|---|---|---|
| permission denied | §2.1-C on every route | `403` **and** absence of effect **and** denial audit |
| role inheritance | §2.2 | that there is **no** inheritance: a role has only what is written |
| expired session | session beyond `maxAge` | `401`; and a persisted session survives a restart |
| kick unauthorized | role without `players.kick` | no call to `mp.kick`; denial audit |
| economy adjustment | adjustment through the panel | balance changes **and** `gold_transactions` gets a row; without permission, neither |
| inventory grant | grant through the panel | `inventory_transactions` gets a row; reason mandatory; `baseId` validated against the plugins (`core/espm`) |
| audit creation | every 🟡/🔴 action | row with `permission`, `reason`, `request_id`, `outcome`, and `before`/`after` when applicable |
| ban | account ban | `accounts.status='banned'` **and** `game_sessions.revoked_at` filled **in the same transaction**; next login refused |
| whitelist review | state transition | `reviewed_by` recorded; invalid transition refused; `NEEDS_CHANGES` allows resubmission |
| concurrent staff actions | two simultaneous `PATCH`es on the same sheet | one wins, the other gets a conflict — **never two `ok:true`** |

### 4.1 Idempotency

| Test | Expected |
|---|---|
| Same `Idempotency-Key`, two requests | one effect, two identical responses |
| Repeated key with a different body | refused; a key is not an alias for "do it again" |
| Double click on ban | one ban, one audit row |

The pattern already exists in the project: `gold_transactions.idempotency_key` with `UNIQUE`,
used by the whitelist starting gold. The panel reuses the idea; it does not invent another.

---

## 5. What only the database can lock

These are not unit-testable and therefore tend to be left out — which makes them
the most fragile part.

| Control | State | Why it matters |
|---|---|---|
| Panel SQL user without `DELETE`/`UPDATE` on `audit_logs` | ❌ one user for everything | it is the difference between "there is no route" and "it is not possible" |
| `game-api` SQL user restricted to the tables it uses | ❌ | least privilege |
| `FK` from `staff_roles.role` to the role catalog | ❌ | closes the phantom role from §2.2 |
| Permission `FK` to the catalog | ❌ | prevents an invented permission in production |
| Rehearsed backup and restore | ❌ | `audit_logs` is the record of last resort |

---

## 6. Mutation — the house rule

When the tests exist, each claim in §1 gets a mutation applied to the
real code and reverted afterwards. A test that passes with the bug back in tests
nothing — and in this project that has already cost dearly: 22 Papyrus calls with the wrong
argument spent months with a green suite (`CONTRIBUTING.md` §6).

Minimum mutations, one per claim:

| Mutation to apply | Must fail |
|---|---|
| `requirePermission` always returns `next()` | every test C |
| Replace permission resolution with "has a row in `staff_roles`" | all of §2.2 |
| Ignore `expires_at`/`revoked_at` in resolution | temporary role tests |
| Make `deny` lose to `grant` | override test |
| Move the audit out of the ban transaction | ban test |
| Remove `UPDATE game_sessions ... revoked_at` from the ban | reconnection-after-ban test |
| Ignore `Idempotency-Key` | §4.1 |
| Accept an empty `reason` on the server | 🔴 action tests |

---

## 7. Gate

No staff member other than the owner gets access to the panel before:

1. §2.1 complete — three tests per administrative route, without exception;
2. §2.2 complete, including unknown, expired and revoked roles;
3. §2.3 — no orphan permission, no invented permission;
4. MariaDB session with regeneration at login;
5. denial auditing working;
6. §5 rows 1 and 3 (SQL user privilege on `audit_logs`, role FK).

Items 1–5 are code and tests. Item 6 is operations, and it is the only one that cannot be
verified by running `npm test` — which is why it is written here and not only in the
head of whoever provisions the database.
