# Economy security matrix

**What is locked by tests, what is locked only by the database, and what is not
locked.** The three columns exist because mixing them is how a project
comes to think it is tested.

- Run: `cd skymp/gamemode && npm test`
- Economy only: `node --test core/economy-service.test.js contracts-service.test.js debt-service.test.js`
- State on 2026-08-13: **784 tests, 784 passing**, of which **68** belong to this matrix.

References: [audit](../research/ECONOMY_FRAMEWORK_AUDIT.md) ·
[ADR 004](../technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md) ·
[framework](../framework/ECONOMY_FRAMEWORK.md)

---

## 0. The central claim

> Every balance change in the gamemode goes through `core/economy-service.js` or
> `core/transaction-service.js`, happens inside a transaction, writes both
> legs to the ledger, and refuses instead of failing silently.

This is true **for the code**, and it was verified by mutation. It is not true
for the running server — nothing here has been seen with people inside. The
[Phase 0](../technical/FASE_0_ROTEIRO.md) remains the real blocker, and an
Economy Framework tested only with a mocked `mp` and simulated MySQL is the fifth
system in that condition.

---

## 1. Mutation: do the tests fail when the code gets worse?

A test that passes with the bug back in tests nothing. Five mutations were
applied to the real code and reverted afterwards:

| Mutation applied | Test that failed | ✓ |
|---|---|---|
| Remove the canonical ordering in `_lockPair` (go back to locking "payer, payee") | `always locks in the same order, regardless of who pays` | ✅ |
| Remove the replay query from inside the transaction | `repeating the same key returns the original result` + `the replay query happens INSIDE the transaction` | ✅ |
| Remove the `INT` overflow guard on credit | `refuses a credit that overflows the balance INT` | ✅ |
| Add `delivered` to `EXPIRABLE` (let expiration steal delivered work) | `does NOT expire an already delivered contract, even past the deadline` | ✅ |
| Remove the `creator_cannot_accept` check | `the creator cannot accept their own contract` | ✅ |

Five mutations, five failures, no false greens.

---

## 2. Briefing §13 items, one by one

| Threat | Where it is closed | Test | State |
|---|---|---|---|
| **negative values** | `normalizeAmount` refuses `≤ 0`; balance checked under `FOR UPDATE`; `WHERE ... + ? >= 0` in the treasury `UPDATE`; `CHECK (balance >= 0)` on escrow | `refuses zero amount` · `refuses negative amount` · `insufficient balance returns a code and moves nothing` | ✅ |
| **integer overflow** | `MAX_GOLD = 2147483647` refuses a credit that would overflow | `refuses an amount above the INT ceiling` · `refuses a credit that overflows the balance INT` | ✅ |
| **double spend** | `SELECT ... FOR UPDATE` before every debit; balance check under the lock | `insufficient balance returns a code and moves nothing` | ⚠️ logic tested, concurrency not (§4.1) |
| **race** | locks in canonical `type:ref` order | `always locks in the same order` | ⚠️ order tested, race not |
| **replay** | raw key on the debit leg, `UNIQUE` + `FOR UPDATE` inside the transaction | `repeating the same key returns the original result` · `the replay query happens INSIDE the transaction` | ✅ |
| **fake contract** | `create` requires a funded escrow in the same transaction; category comes from a closed list | `without balance no contract remains — fail-closed` · `refuses a category outside the list` | ✅ |
| **fake completion** | only whoever accepted delivers; only the creator (or the sweep) settles | `only whoever accepted declares delivery` · `the worker cannot pay themselves` | ✅ |
| **unauthorized cancellation** | only the creator, and only while `open` | `only the creator cancels` · `does not cancel after acceptance` | ✅ |
| **escrow duplicate release** | `status` leaves `held` under the same lock; replay checked before status | `releasing twice with different keys is refused` · `resending the SAME release returns replay` | ✅ |
| **disconnect** | the database is the source of truth; the client is touched only after the commit | (inherited from `transaction-service`) | ⚠️ §4.3 |
| **DB rollback** | an infrastructure failure **throws**, never becomes `ok:false` | `infrastructure failure THROWS — does not become {ok:false}` (×3 services) | ✅ |

---

## 3. Briefing §16 items

### 3.1 `transfer`

| Scenario | Test | ✓ |
|---|---|---|
| Moves balance on both sides | `moves the balance and writes both legs with the same transfer_id` | ✅ |
| Both legs share `transfer_id` | same | ✅ |
| Raw key on the debit, `#in` on the credit | same | ✅ |
| Treasury credits **with** a ledger | `credits a city treasury WITH a ledger on both sides (Finding 2)` | ✅ |
| Null `character_id` for a non-character holder | same | ✅ |
| Actor recorded when ≠ holder | `records the actor when the requester is not the holder` | ✅ |
| Refuses a transfer to oneself | `refuses a transfer to the same account` | ✅ |
| Refuses an unknown holder | `refuses an unknown holder type` | ✅ |
| Refuses `system` without a readable label | `refuses system without a readable label` | ✅ |
| A nonexistent account is a refusal, not an exception | `nonexistent account is a refusal, not an exception` | ✅ |
| Invalid amounts (0, negative, NaN, fractional, string, above the ceiling) | 6 tests | ✅ |

### 3.2 `double request`

| Scenario | Test | ✓ |
|---|---|---|
| A second call with the same key returns `{ok:true, replayed:true}` | `repeating the same key returns the original result without moving again` | ✅ |
| ...with the original `transferId` | same | ✅ |
| ...without charging again and without writing again | same | ✅ |
| The query happens after `beginTransaction` | `the replay query happens INSIDE the transaction` | ✅ |
| Debt payment replay | `resending the SAME payment does not charge twice` | ✅ |
| Contract settlement replay | `resending the SAME settlement returns replay, not an error` | ✅ |
| Contract creation replay | `repeating creation with the same key does not publish two contracts` | ✅ |
| Escrow release replay | `resending the SAME release returns replay, not escrow_not_held` | ✅ |

### 3.3 `market sale`

| Scenario | Test | Where | ✓ |
|---|---|---|---|
| Stock, gold, tax and inventory in a single commit | `opens a transaction and commits once` | `market-stalls-purchase.test.js` | ✅ |
| Buyer pays the total, seller receives the net | `debits the buyer and credits the seller minus the tax` | same | ✅ |
| **The tax has a ledger row** (Finding 2) | `records the payment AND the tax in the ledger` | same | ✅ |
| **The sum of a sale's deltas is zero** | same | same | ✅ |
| No balance → rollback, nothing partial | `refuses without leaving a partial trace` | same | ✅ |
| Internal errors do not leak to the screen | same | same | ✅ |
| A repeated `requestId` does not charge twice | `repeats the same requestId without charging...` | same | ✅ |
| Regional market: buy/sell against `system` | `buys stock, gold and inventory in the same commit` · `sale moves item, gold, tax, stock and ledger` | `core/regional-market-...test.js` | ✅ |

### 3.4 `contract` and `escrow`

| Scenario | Test | ✓ |
|---|---|---|
| Escrow locks at post time | `locks the reward at publication time` · `locks the amount at post` | ✅ |
| No balance → **no contract** (fail-closed) | `without balance no contract remains` · `does not open escrow without balance` | ✅ |
| Settlement pays exactly the reward | `pays exactly the reward to the worker and closes the escrow` | ✅ |
| The creator does not accept their own contract | `the creator cannot accept their own contract` | ✅ |
| A second worker does not steal an accepted contract | `a second worker does not steal an already accepted contract` | ✅ |
| The worker does not pay themselves | `the worker cannot pay themselves` | ✅ |
| Double settlement refused | `settling twice with different keys is refused` | ✅ |
| Refund to the funder marks `refunded` | `refunding the funder marks refunded, not released` | ✅ |
| Escrow purpose outside the list | `refuses a purpose outside the list` | ✅ |

### 3.5 `cancel` and `expire`

| Scenario | Test | ✓ |
|---|---|---|
| Cancelling returns the escrow to the creator | `returns the escrow to the creator while open` | ✅ |
| Cancelling after acceptance is refused | `does not cancel after acceptance` | ✅ |
| Only the creator cancels | `only the creator cancels` | ✅ |
| Expiring an open contract returns to the creator | `expires an open contract and returns to the creator` | ✅ |
| **Expiration does NOT touch delivered work** | `does NOT expire an already delivered contract, even past the deadline` | ✅ |
| Does not expire early | `does not expire before its time` | ✅ |
| A contract without a deadline never expires | `a contract without a deadline never expires` | ✅ |
| Automatic settlement after the window | `settles on its own after the review window` | ✅ |
| Does not settle within the window | `does not settle on its own within the window` | ✅ |
| A dispute locks everything; the sweep does not decide | `a dispute locks everything: nobody gets paid and the sweep does not decide` | ✅ |
| Only the creator disputes | `only the creator disputes` | ✅ |

### 3.6 `debt`

| Scenario | Test | ✓ |
|---|---|---|
| **Opening a debt moves no septim** | `records without moving any septim` | ✅ |
| The same origin does not become two debts | `the same origin does not become two debts` | ✅ |
| A debt with oneself is refused | `refuses a debt with oneself` | ✅ |
| `system` creditor refused | `refuses a system creditor — nobody owes the void` | ✅ |
| Institutional creditor accepted | `accepts an institutional creditor` | ✅ |
| Payment moves septims and reduces the debt | `moves the septim and reduces the outstanding balance` | ✅ |
| Settlement zeroes and closes | `paying off zeroes and closes` | ✅ |
| **Transfer fails → `remaining` does NOT drop** | `if the transfer fails, the outstanding balance does NOT drop` | ✅ |
| Paying more than the outstanding balance refused | `refuses paying more than is owed` | ✅ |
| A closed debt does not accept payment | `does not pay an already settled debt` | ✅ |
| Forgiveness zeroes without moving septims | `zeroes without moving septims` | ✅ |
| Partial forgiveness keeps the debt alive | `partial forgiveness keeps the debt alive` | ✅ |
| **`defaulted` does not confiscate and does not block** | `marking defaulted moves nothing and does not block payment` | ✅ |

### 3.7 `admin adjustment`

| Scenario | Test | ✓ |
|---|---|---|
| Credit comes from `system:staff_adjust` | `credits against system and leaves the actor in the ledger` | ✅ |
| Debit goes to `system:staff_adjust` | `debits against system when the amount is negative` | ✅ |
| Actor mandatory | `requires an actor — anonymous adjustments do not exist` | ✅ |
| `/setgold` goes through the ledger, never through a loose `UPDATE` | `setGold moves gold through the ledger, never through a loose UPDATE` (`permissions.behavior.test.js`) | ✅ |

### 3.8 `rollback`

| Scenario | Test | ✓ |
|---|---|---|
| A failure in the economy throws and rolls back | `infrastructure failure THROWS — does not become {ok:false}` | ✅ |
| A failure in contract creation throws and rolls back | `throws and rolls back instead of returning {ok:false}` | ✅ |
| A failure in debt payment throws and rolls back | same, `debt-service.test.js` | ✅ |
| A failure in a stall purchase rolls back without a trace | `refuses without leaving a partial trace` | ✅ |

### 3.9 `concurrent transactions`

**⚠️ Not covered.** See §4.1.

---

## 4. What is **not** covered, and why

### 4.1 Real concurrency

No test runs two operations at the same time against a real MySQL.

What **is** verified: that the `SELECT ... FOR UPDATE` statements are issued, that the
lock order is canonical, that the replay query happens after
`beginTransaction`, and that the balance `UPDATE` repeats the guard in the `WHERE`.

What is **not**: that InnoDB serializes the way the logic assumes. Two people
accepting the same contract in the same millisecond, or buying from each other's
stall simultaneously, has never been observed — only reasoned about.

Closing this requires a real database and real concurrency, which is Phase 0 work.

### 4.2 Concurrency between `getGold` and the delta in `/setgold`

`admin-service.setGold` reads the balance outside the transaction and applies a delta. If the
balance changes between the two, the result is the value requested by staff with a deviation
the size of the concurrent operation. This is **known and accepted**, it is
documented in the file itself, and the ledger shows both rows — the divergence
is visible instead of silent.

### 4.3 Client ↔ server reconciliation

`applyToClient` runs after the commit and is not `await`ed by anyone. If it fails,
the database is right and the client is not. Login reconciliation exists for items;
gold has no mirror on the client, so the problem is smaller — but no test
observes an `applyToClient` failure followed by reconnection.

### 4.4 Balance reconciliation against the ledger

`economy.reconcile()` exists and works. **Nothing runs it periodically.** And it
is only conclusive for balances created after v15: `characters.gold` has
history older than the ledger and will diverge by construction — which is why the function
returns `ledgerSum` along with it, not just a verdict.

### 4.5 Migration v15

It has not been applied to any database. `npm run check:schema:list` confirms that the
five new tables and the six new columns are **declared**; nobody has seen the `ALTER`
run on a real MariaDB.

Two `check-schema-drift.js` traps recorded in the migration file:

1. `MODIFY COLUMN` is not read — the nullability of `gold_transactions.character_id`
   does not show up as drift if the migration is not applied. Check by hand.
2. ~~A `;` inside a `COMMENT '...'` cuts off the body of the `ALTER`~~ — **fixed
   on 2026-08-13.** The parser delimited the statement at the first `;` in the text, without
   knowing strings exist, and the following `ADD INDEX` clauses silently vanished from the
   expected declaration, with the command exiting with code 0. It happened
   while writing this v15: three `gold_transactions` indexes became invisible.
   `instrucoesSql` and `semComentarios` now walk the SQL aware of
   quotes, and the two `COMMENT`s with a semicolon remain in the migration **on
   purpose** — they are the regression that `scripts/check-schema-drift.test.js`
   checks.

### 4.6 PARKED services with the old pattern

`housing-service.buyProperty` and `horse-service` still charge in one transaction and
deliver in another
([Finding 9](../research/ECONOMY_FRAMEWORK_AUDIT.md#10-achado-9--compra-de-propriedade-cobra-antes-de-entregar)).
They do not run, and `parked-services-ledger.test.js` guarantees that they at least go
through `transaction-service` instead of a loose `UPDATE ... SET gold`. Migrating to
`economy-service` is pending, and **migrating is not reactivating**.

### 4.7 `accounts.coins`

Out of scope by product decision
([Finding 12](../research/ECONOMY_FRAMEWORK_AUDIT.md#13-achado-12--accountscoins-é-dinheiro-e-não-está-nesta-auditoria)).
No tests, because no gamemode code touches the column — and the absence of a
conversion path to septims is the right thing.

### 4.8 A real session

Zero. No fine has been applied, no contract published, no escrow
released on a server with players. It is the same caveat as every matrix in this
repository, and it remains the most important.

---

## 5. How to run

```bash
cd skymp/gamemode && npm test
```

Economy only:

```bash
cd skymp/gamemode && node --test core/economy-service.test.js contracts-service.test.js debt-service.test.js core/transaction-service.test.js market-stalls-purchase.test.js core/regional-market-transaction-service.test.js
```

Check the declared schema (no database needed):

```bash
cd skymp/gamemode && npm run check:schema:list
```

Check against a real database:

```bash
cd skymp/gamemode && npm run check:schema
```
