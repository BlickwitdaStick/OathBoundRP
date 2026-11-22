# Inventory transaction matrix

What is covered, what is not, and **why** each row exists.

**Date:** 2026-08-13 · Suite: `npm test` — 716 tests, 169 suites, 0 failures.
New in this round: 45 in `core/inventory.test.js`, 25 in
`trade-service.test.js`.

> Companion to [`INTERACTION_TEST_MATRIX.md`](INTERACTION_TEST_MATRIX.md).
> The rule is the same: a "covered" row means **there is a test that
> fails if the guarantee disappears** — verified by mutation, not by reading.

---

## 0. The central claim

The tests of this framework do not ask *"did the function return `true`?"*. They ask:

> **For every `transfer_id`, the sum of the `delta` values written to the ledger is zero.**

A `result.ok` check passes on any implementation that returns
`true`. The sum only balances if the item really left one place and entered
another. If someone creates a new path that moves items without writing both legs,
`conferirConservacao()` fails without knowing that path exists.

It is the form inherited from Phase 3's `conferirOuroFecha`, applied to items.

---

## 1. Verified mutations

Applied to the code, executed, reverted. Not predicted — executed.

| Mutation | Failed? | Tests that fell |
|---|---|---|
| `session.version += 1` removed (an offer change does not drop the confirmation) | **yes** | 1 |
| `system` owner leg omitted from the ledger | **yes** | 1 |
| Idempotency replay turned off | **yes** | 1 |
| `delta` validation removed from `applyStackDelta` | **yes** | 4 |
| Distance revalidation removed from the trade commit | **yes** | 1 |
| Item/quantity validation ignored in `exchange` | **yes** | 12 |

Clean baseline before and after (`rc=0, fail=0`).

---

## 2. Transfer

| Case | Covered | Where |
|---|---|---|
| Simple transfer between characters | yes | `core/inventory.test.js` |
| Stack merge (item the destination already has) | yes | same — `applyStackDelta` adds |
| Stack split (moving part) | yes | same |
| A zeroed stack is deleted, not left at 0 | yes | same, via `DELETE` |
| Two quantities of the same item in the same request are summed | yes | *"sums quantities of the same item"* |
| Source equal to destination is refused | yes | `SAME_OWNER` |
| An owner of a type without an adapter fails closed and by name | yes | `NO_ADAPTER` |
| A nonexistent container refused **inside** the transaction | yes | `OWNER_NOT_FOUND` |
| An offline character (no `actorId`) receives an item | yes | *"projects to the client only after the commit"* |
| Insufficient stock moves nothing | yes | |
| An SQL error does not reach the player's screen | yes | |
| The client is only touched after the `commit` | yes | |

---

## 3. Dupe protection — §9 of the request, item by item

| Scenario | Before | Now | Where |
|---|---|---|---|
| **Double click** | partial (memory only) | **yes** | `duplicate: true` returns the same `transferId`, the item leaves once |
| **Repeated packet** | partial | **yes** | same — the key survives a restart, it is in the database |
| **Reconnection** | partial | partial | `_syncedThisSession` is still per session; the boundary of [ADR_003 §3](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md) has not closed |
| **Disconnect during a transfer** | no | **yes** | `trade-service.test.js`: *"whoever leaves midway cancels"* |
| **Trade cancellation** | no | **yes** | *"cancelling releases both sides"* |
| **Database timeout** | no | **yes** | `erroForcado` on the ledger INSERT → rollback, nothing moved, generic message |
| **Two simultaneous transfers** | partial (gold only) | partial | see §6 |
| **Same item sold and traded** | no | **yes** | *"whoever sold the item between confirmation and closing donates nothing"* |
| **Same item crafted and dropped** | no | **yes** | *"crafting without the ingredient does not deliver the result"* — the `FOR UPDATE` is the same protection |

---

## 4. Security — §19 of the request

| Attack | Covered | Response |
|---|---|---|
| Negative quantity | yes | `INVALID_QUANTITY`, without opening a transaction |
| Zero quantity | yes | `INVALID_QUANTITY` |
| `NaN` | yes | `INVALID_QUANTITY` / `INVALID_ITEM` |
| `Infinity` | yes | same |
| Fractional (`1.5`) | yes | same |
| Overflow (`2e6` per item) | yes | per-operation ceiling |
| Stack overflow (MySQL `INT`) | yes | `Pilha cheia` ("stack full"), instead of silently saturating |
| Unknown FormID | yes | `UNKNOWN_FORMID`, when `espm` **knows** it is not an item |
| FormID as a string (`"0x10"`) | yes | `INVALID_ITEM` — the API does not guess the base |
| Fake container | yes | `OWNER_NOT_FOUND`, inside the transaction |
| Fake target (trade) | yes | `requestTrade` refuses an actor without a character |
| Distance spoofing | yes | the server measures; the client does not send distance |
| Trade replay | yes | `requestId = sessionId.vN`; `COMMITTING` blocks the second confirm |
| Craft replay | yes | `requestId` without `Date.now()` |
| Duplicate `requestId` | yes | `duplicate: true`, does not execute again |
| Injection via table name | yes | `STACK_TABLES` is a closed list; test with `'characters; DROP TABLE x'` |
| Invented `system` origin | yes | closed list — `presente_de_natal` throws |

---

## 5. Trade — §20 of the request

| Case | Covered |
|---|---|
| Invitation created, indexed by both sides | yes |
| Nonexistent / self / invalid target | yes |
| Someone already in a trade is refused, on both sides | yes |
| The inviter does not accept their own invitation | yes |
| Invitation expires (45 s) | yes |
| Session expires (3 min) and releases both | yes |
| Offering more than one has is refused immediately | yes |
| A negative quantity removes from one's own offer, without creating a debt | yes |
| Per-side type ceiling | yes |
| **An offer change drops both confirmations** | yes |
| Version goes up with each change | yes |
| An empty trade does not close | yes |
| Only the second confirm triggers the commit | yes |
| The commit moves both sides and ends the session | yes |
| Conservation (zero sum per `transfer_id`) | yes |
| Possession revalidated at commit | yes |
| One side leaving invalidates | yes |
| Swapping characters on the same actor invalidates | yes |
| Moving away invalidates (with `mp` really measuring) | yes |
| Disconnection cancels and leaves no orphan item | yes |
| `sweep()` closes everything | yes |
| The interaction disappears from the menu of someone already trading | yes |
| The interaction audit is `TRACE` | yes |

---

## 6. What is **not** covered, and why

### 6.1 Real concurrency

The tests run against a single-threaded in-memory database. `FOR UPDATE`,
gap locks and deadlocks **are not exercised** — the mock does not block.

What the tests cover is that the code **requests** the lock (`SELECT … FOR UPDATE`
appears in the query) and that the acquisition order is deterministic (operations are
sorted by `(owner key, base_id)`, which makes the A→B/B→A cycle
impossible). That MariaDB honors this is an assumption, not a claim.

**How to close it:** an integration test with a real database and two concurrent
connections. `RUN_DB_CHECK=1 npm run test:systems` is already where this kind
of test lives in this project.

### 6.2 Migration v14

`check-schema-drift.js` checks tables, columns and indexes — and **does not recognize
`MODIFY COLUMN`**. The nullability change of
`inventory_transactions.character_id` does not show up as drift if the migration is
skipped. Manual check:

```sql
SHOW COLUMNS FROM inventory_transactions LIKE 'character_id';
```

The migration's duplicate consolidation has no test either: it runs once,
against data that may not exist.

### 6.3 Client → server reconciliation

Still one-way. An item picked up from the ground by the player does not become a row in the database and
no test pretends it does. It is the boundary of
[ADR_003 §3](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md), left open on
purpose.

### 6.4 Capacity and weight

They do not exist. There is no test because there is no behavior.

### 6.5 The stall

`addItem`, `packStall` and `removeItem` now move inventory **inside** the
stall transaction. `market-stalls-purchase.test.js` and
`market-stalls-service.test.js` remain green and cover the purchase, which was already
the correct path. **The new atomicity of the other three has no test of its own** —
the change is structural (same primitives, inside the `BEGIN` that already existed) and
verifiable by reading, but that is weaker than the other items in this matrix.

It is the most actionable gap on the list.

### 6.6 A real session

Zero players. 716 green tests prove that the code does what the tests say;
they do not prove that SkyMP behaves the way this project assumes.

---

## 7. How to run

```bash
npm test
```

Only the inventory framework and trade:

```bash
node --test core/inventory.test.js trade-service.test.js
```
