# Economy Framework

**How to handle money in Heavy RP.** If you are writing a module that
charges, pays, taxes, fines, rewards or locks value, this document is the contract.

- Decision: [ADR 004](../technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md)
- Evidence: [economy audit](../research/ECONOMY_FRAMEWORK_AUDIT.md)
- Schema: [migration v15](../../skymp/packages/database/migration-v15-economy-framework.sql)
- Code: [`core/economy-service.js`](../../skymp/gamemode/core/economy-service.js)

---

## 1. The rule

> **No module changes a balance directly. Not `characters.gold`, not
> `cities.treasury`, not `holds.treasury`, not `factions.treasury`.**

One door: `core/economy-service.js`.

```
governance · stall · contracts · debt · rent · work · shop
                              │
                              ▼
                   core/economy-service.js
        (validation · idempotency · lock order · two-sided ledger)
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
core/transaction-service   treasuries          economy_escrow
   characters.gold      *.treasury               balance
```

`core/transaction-service.js` still exists and is still the **only**
file that writes `characters.gold`. It is the engine. The `tx.*` primitives are
its own; domain modules do not call them.

**How to know you are wrong:** if your module `require`s
`core/transaction-service` to touch gold, or contains a `SET gold` /
`SET treasury` string, it is wrong.

---

## 2. An account is a reference

An account is the pair `{ type, ref }`. The service resolves where the balance lives.

| `type` | `ref` | Actual balance | Example |
|---|---|---|---|
| `character` | `characters.id` | `characters.gold` | `{ type: 'character', ref: 7 }` |
| `city` | `cities.id` | `cities.treasury` | `{ type: 'city', ref: 'whiterun' }` |
| `hold` | `holds.id` | `holds.treasury` | `{ type: 'hold', ref: 'whiterun' }` |
| `faction` | `factions.id` | `factions.treasury` | `{ type: 'faction', ref: 3 }` |
| `realm` | `realms.id` | `realms.treasury` | `{ type: 'realm', ref: 'skyrim' }` |
| `escrow` | `economy_escrow.escrow_id` | `economy_escrow.balance` | `{ type: 'escrow', ref: uuid }` |
| `system` | label | **none** | `{ type: 'system', ref: 'death_penalty' }` |

### `system` is the edge of the world

It is where septims **enter and leave the economy**. It has no balance — on purpose.
Every creation and destruction of money needs a row with `system` on one
side, and the label says what it is:

| Label | What it is |
|---|---|
| `whitelist_grant` | starting gold for an approved character |
| `death_penalty` | drain from the death penalty |
| `staff_adjust` | `economy.adjust` — staff creating or destroying |
| `regional_market` | buying and selling in the NPC market |
| `staff_fine` | fine applied by a staff governor, without an institution |

A new label comes in through a code edit, under review. `[a-z0-9_]{3,48}`.

> **List everything the economy created or destroyed today:**
> ```sql
> SELECT owner_ref, SUM(delta) FROM gold_transactions
>  WHERE owner_type = 'system' AND created_at >= CURDATE()
>  GROUP BY owner_ref;
> ```
> This was impossible before v15.

---

## 3. API

### Transfer

```js
const economy = require('./core/economy-service');

const resultado = await economy.transfer({
  from: { type: 'character', ref: compradorId },
  to:   { type: 'character', ref: vendedorId },
  amount: 250,
  reason: 'stall_purchase',          // ≤ 64 chars, becomes a ledger column
  module: 'market-stalls',
  actorCharacterId: compradorId,     // who REQUESTED it, if not the holder
  idempotencyKey: requestId          // 8–96 chars
});
```

When the operation needs to commit **together with something else** (lowering stock,
delivering an item, closing a contract), use the variant inside the caller's transaction:

```js
const conn = await db.getConnection();
await conn.beginTransaction();
const resultado = await economy.transferInTransaction(conn, { ... });
// ... rest of the operation ...
await conn.commit();
```

Whoever calls `transferInTransaction` **opens, commits and rolls back**. The function
does none of the three.

### Escrow

```js
const escrow = await economy.openEscrow({
  funder: { type: 'character', ref: criadorId },
  amount: 500,
  purpose: 'contract',    // contract | auction | rent_deposit | wager
  reason: 'contract_escrow',
  module: 'contracts',
  idempotencyKey: chave
});
// → { ok: true, escrowId, amount, transferId }

await economy.closeEscrow({
  escrowId: escrow.escrowId,
  beneficiary: { type: 'character', ref: trabalhadorId },
  reason: 'contract_settlement',
  idempotencyKey: outraChave
});
// → { ok: true, amount, outcome: 'released' }   ('refunded' if it goes back to the funder)
```

### Staff adjustment

```js
await economy.adjust({
  target: { type: 'character', ref: alvoId },
  amount: -500,                    // negative debits
  reason: 'estorno_dupe',
  actorCharacterId: staffCharId,   // mandatory
  idempotencyKey: chave
});
```

This file **does not check permissions** — the caller already knows the role. What
it guarantees is that the adjustment is impossible to make without a trace: the other side is
always `system:staff_adjust`, and the actor goes into the `actor_character_id` column.

### Reading

```js
await economy.getBalance({ type: 'city', ref: 'whiterun' });
// → { ok: true, balance: 1240 }

await economy.reconcile({ type: 'city', ref: 'whiterun' });
// → { ok: true, balance: 1240, ledgerSum: 1240, matches: true }
```

---

## 4. The return contract

**This is the most important point of the framework**, and the reason it exists.

```js
{ ok: true,  replayed: false, transferId, amount }   // happened now
{ ok: true,  replayed: true,  transferId, amount }   // had already happened
{ ok: false, code: 'insufficient_funds', balance }   // a game rule refused it
throw new Error(...)                                  // infrastructure broke
```

Three distinct states, and **an infrastructure failure throws** — it never becomes
`ok: false`.

Why this matters: until 2026-08-13 `removeGold` returned a `boolean`, and `false`
meant "has no gold", "already happened" **and** "the database is down". The
`governance-service` read that `false` and issued an **arrest warrant for
default** — so a network timeout produced a warrant against someone who
had the money. See [Finding 7](../research/ECONOMY_FRAMEWORK_AUDIT.md#8-achado-7--false-significa-três-coisas-diferentes).

### Refusal codes

| Code | Means |
|---|---|
| `insufficient_funds` | the balance does not cover it (comes with `balance`) |
| `balance_overflow` | the destination would overflow the balance `INT` |
| `from_account_not_found` / `to_account_not_found` | the holder does not exist |
| `same_account` | source equals destination |
| `invalid_amount` | zero, negative, fractional, NaN or above the ceiling |
| `invalid_from_account` / `invalid_to_account` | unknown type or invalid ref |
| `invalid_reason` / `invalid_idempotency_key` | out of format |
| `escrow_not_found` / `escrow_not_held` / `escrow_empty` | escrow state |

Treat `insufficient_funds` as a game decision. Treat any other code
as a bug in your module — it means you built the request wrong.

---

## 5. Idempotency

Mandatory. The key is stored **raw** on the debit leg of
`gold_transactions.idempotency_key` (`UNIQUE`), and queried with `FOR UPDATE`
**inside** the transaction. A resend returns the original result.

```
requestId from the UI  →  idempotencyKey
                          ├── debit leg:   "req-abc123"
                          └── credit leg:  "req-abc123#in"
```

If your operation makes more than one transfer, derive stable suffixes:

```js
idempotencyKey: `${requestId}_pay`   // payment
idempotencyKey: `${requestId}_tax`   // tax
```

**Stable** is the word: `Date.now()` or `Math.random()` in the middle of the key
turns a retry into a second payment.

When the request has no `requestId` (chat command, server sweep),
generate a deterministic one from what identifies the operation —
`sweep-expire-${contractId}` is the contract sweep's key, and it is what
prevents the sweep from expiring twice if it runs twice in the same minute.

---

## 6. The ledger

`gold_transactions` after v15:

| Column | Purpose |
|---|---|
| `transaction_id` | UUID of the row |
| `transfer_id` | **shared by both legs** — it is what links payer and payee |
| `character_id` | filled in when the holder is a character; `NULL` otherwise |
| `owner_type` / `owner_ref` | whose leg this is |
| `counterparty_type` / `counterparty_ref` | the other side |
| `actor_character_id` | who requested it, when not the holder |
| `delta` | negative debits, positive credits |
| `reason` / `module` | what and from where |
| `idempotency_key` | `UNIQUE`; raw on the debit leg |
| `status` | `committed` / `rolled_back` |

Queries that v15 made possible:

```sql
-- The whole operation, both sides
SELECT * FROM gold_transactions WHERE transfer_id = ?;

-- A treasury's balance rebuilt from history
SELECT SUM(delta) FROM gold_transactions WHERE owner_type='city' AND owner_ref='whiterun';

-- Everything a staff member moved
SELECT * FROM gold_transactions WHERE actor_character_id = ? ORDER BY created_at DESC;
```

### About "safe metadata" (briefing §5)

There is no free-form JSON column, and that is a decision, not an oversight. The fields the
briefing asks for — `from`, `to`, `type`, `reason`, `actor`, `timestamp` — all
exist as **typed, indexable columns**. A free-form metadata blob would be
where player text, item names and error messages end up going in
without validation, and where nobody can query later. Need a new
field? It becomes a column, with a migration and review.

---

## 7. Invariants

Seven things the service guarantees that you do not need to reimplement:

1. **A balance never goes negative.** Checked under `FOR UPDATE`, and the treasury
   `UPDATE` repeats the guard in the `WHERE` as a second line of defense.
2. **A balance never overflows the `INT`.** A credit that would go past `2147483647` is
   refused with `balance_overflow` instead of silently saturating.
3. **Locks in canonical order** (sorted `type:ref`), not "payer first" —
   it is what prevents a deadlock when A buys from B while B buys from A.
4. **Every balance change has a ledger row.** There is no path that changes a balance
   without writing both legs.
5. **Idempotency inside the transaction**, with a typed replay.
6. **Escrow releases once.** `status` leaves `held` under the same lock.
7. **Refusal ≠ failure.** See §4.

---

## 8. How to extend

### A new holder type

Edit `ACCOUNT_KINDS` in `core/economy-service.js`. It is a closed list because the
table and column names are **interpolated into the SQL** (a `?` does not work for an
identifier), and the closed list is what makes that safe by construction.
No name coming from a payload reaches the SQL.

The holder needs a table with a primary key and a non-negative `INT`
balance column.

### A new escrow purpose

Edit `ESCROW_PURPOSES`. Today: `contract`, `auction`, `rent_deposit`, `wager`.

### A new `system` label

No list — the format is `[a-z0-9_]{3,48}`. But choose a name that answers
"where did this gold come from" in an investigation. `mint` does not answer it;
`whitelist_grant` does.

---

## 9. What this framework does **not** do

Written down because a framework that only lists capabilities misleads.

1. **It does not check permissions.** Who can fine, who can withdraw from the faction
   treasury and who can adjust balances is a decision of the governance and staff modules.
   Duplicating it here would create two places to maintain the same rule.
2. **It does not convert currency.** `accounts.coins` (shop, real money) is out, on
   purpose, and adding that path is a product decision — see
   [Finding 12](../research/ECONOMY_FRAMEWORK_AUDIT.md#13-achado-12--accountscoins-é-dinheiro-e-não-está-nesta-auditoria).
3. **It does not reconcile automatically.** `reconcile()` exists and is a query;
   nothing runs it periodically yet.
4. **It does not impose economic policy.** There is no issuance quota, drain ceiling,
   inflation or interest. `system` accepts any amount with a mandatory `reason`.
5. **It does not reverse.** A reversal is a new transfer in the opposite direction, with a
   `reason` that names it. A ledger row is never deleted or edited.
6. **It has not run on a server with people inside.** Everything here is tested with simulated MySQL
   and a mocked `mp`, like the rest of the gamemode. The
   [Phase 0](../technical/FASE_0_ROTEIRO.md) remains the real blocker.

---

## 10. Migration of existing modules

Done on 2026-08-13:

| Module | Before | Now |
|---|---|---|
| `governance-service.fineTarget` | `removeGold` + 2 loose queries | one transaction; the fine credits the institution; default opens a real debt |
| `market-stalls-service.buyItem` | 2× `applyGoldDelta` + a loose `UPDATE cities` | 2 transfers (payment and tax), 4 ledger legs that sum to zero |
| `regional-market-transaction-service` | `applyGoldDelta` + a loose `UPDATE holds` | buying and selling against `system:regional_market`; tax is a transfer |

Pending, and recorded: `housing-service.buyProperty` and `horse-service` (both
PARKED) still charge in one transaction and deliver in another —
[Finding 9](../research/ECONOMY_FRAMEWORK_AUDIT.md#10-achado-9--compra-de-propriedade-cobra-antes-de-entregar).
Migrating is **not** reactivating
([PARKED_SERVICES_DECISION](../technical/PARKED_SERVICES_DECISION.md)).

---

## 11. See also

- [`CONTRACTS.md`](../gameplay/CONTRACTS.md) — the first consumer of escrow
- [`DEBT_SYSTEM.md`](../gameplay/DEBT_SYSTEM.md) — debt as a record
- [`ECONOMY_SECURITY_MATRIX.md`](../testing/ECONOMY_SECURITY_MATRIX.md) — what is tested, and what is not
- [`INVENTORY_FRAMEWORK.md`](INVENTORY_FRAMEWORK.md) — the equivalent for items
