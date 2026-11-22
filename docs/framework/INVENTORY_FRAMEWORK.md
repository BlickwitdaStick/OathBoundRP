# Inventory Framework

**Status:** implemented, tested (70 new tests, 6 verified mutations) and
**it is the mandatory path** for an item that changes owner. **It has never run in a real
session** — the sentence carries the same weight as in
[`INTERACTION_FRAMEWORK.md`](INTERACTION_FRAMEWORK.md).

Files:

| File | Responsibility | Touches `mp`/database? |
|---|---|---|
| [`core/inventory-owner.js`](../../skymp/gamemode/core/inventory-owner.js) | The vocabulary of "whose item is this" | **No** — pure function |
| [`core/inventory.js`](../../skymp/gamemode/core/inventory.js) | Moves items between owners, in one transaction | Database, injected via `transaction-service` |
| [`core/transaction-service.js`](../../skymp/gamemode/core/transaction-service.js) | Locks rows, refuses insufficient stock, writes the ledger | Yes — it is the only one that writes stacks |

---

## 1. The problem

`core/transaction-service.js` does what it promises: `BEGIN`, `SELECT … FOR UPDATE`,
ledger, `idempotency_key`. **But it only knows how to talk about one owner: a character.**

Every time an item needed to go somewhere else, whoever needed it wrote
the other side by hand, outside the transaction — three implementations, with the same shape
of defect that has already been deleted twice in this project. Full diagnosis in
[`INVENTORY_TRADE_CRAFTING_AUDIT.md`](../research/INVENTORY_TRADE_CRAFTING_AUDIT.md).

---

## 2. The central rule

> **The ledger balances to zero.**

For every `transfer_id`, the sum of the written `delta` values is zero. Items do not appear and
do not vanish: they leave one owner and enter another, and both sides leave a row —
including when one of the sides is the void.

It is this property, and not the functions' return values, that the tests
assert. A `result.ok` check passes on any implementation that
returns `true`; the sum only balances if the item really moved.

---

## 3. Which API to use

| Situation | Use |
|---|---|
| Only one owner changes (giving/taking from a character) | `transactionService.giveItem` / `removeItem` |
| **Two owners** (trade, chest, stall, craft) | `inventory.transfer` |
| Two or more legs that need to commit together | `inventory.exchange` |
| An item is created or destroyed | `inventory.mint` / `inventory.burn` |
| The operation needs to commit together with gold | the `tx.*` primitives, in your transaction |

The last row is the stall purchase, and it remains the right form for it:
`market_stall_items` is not a stack (it carries price, label and status per
listing), so the stall opens its own transaction and uses `tx.*` inside it.

---

## 4. The item model

### 4.1 The stack is the default

```
(owner, base_id, count)
```

`base_id` is the native FormID, **in decimal** in the database. There is no instance, no
durability, no provenance.

### 4.2 Instance: designed, not built

§5 of the request asks for the design and warns against turning everything into a UUID. The
design is this:

```
ItemDefinition   base_id → { type, stackable, needs_instance }   (today: core/espm.js)
ItemInstance     uuid, definition, owner, metadata               (does not exist)
Stack            (owner, base_id, count)                         (is what exists)
```

**No definition opts into instances today**, and the table was not created. Three
reasons, in order of weight:

1. **Native Skyrim does not have the concept.** `AddItem(baseId, count)` is the only
   delivery API. An instance in the database would have no way of being projected onto the
   client — it would exist only for the server, and the player would see a sword
   identical to any other.
2. **It costs a row per unit.** 400 arrows become 400 rows in a table read at
   everyone's login.
3. **No current system reads metadata.** Stall, governance, craft and death
   work with stacks.

**The trigger to build it**, for whoever gets here later: the first requirement
that needs to distinguish two units of the same `base_id` — durability,
"this sword was forged by So-and-so", marked contraband. Then the shape is an
`item_instances` table and a `needs_instance` in the definition, with the adapter
routing through it. Until then, building it would be the premature abstraction that the
`module-registry` refused on 2026-08-06, by the same argument.

### 4.3 Metadata

§6 of the request lists durability, quality, `craftedBy`, stolen, custom
name, origin, enchantment, serial, expiration.

All of them depend on instances (§4.2), **and none is accepted from the client**. When they
exist, they are born server-side: an interaction's `execute` receives `data` already
sanitized by the `schema`, and an undeclared field does not reach the module — the rule of
[`INTERACTION_FRAMEWORK.md`](INTERACTION_FRAMEWORK.md) §5 applies here unchanged.

---

## 5. Owners

```js
const inventory = require('./core/inventory');

inventory.character(characterId, actorId)   // optional actorId: only projects to the client
inventory.container(containerId)            // containers.id, not the formDesc
inventory.system('craft')                   // the void, with a named origin
```

Seven types, **three with storage**:

| Type | Adapter | Where it lives |
|---|---|---|
| `character` | yes | `character_inventory` |
| `container` | yes | `container_inventory` |
| `system` | — (it is the void) | ledger only |
| `property` | **no** | today a property *is* a container |
| `faction` | **no** | there is no faction item table |
| `corpse` | **no** | `corpse-probe` observes, it does not store |
| `market` | **no** | `market_stall_items` is an offer, not a stack |

A request against a type without an adapter fails with *"Tipo de dono nao
suportado"* ("Owner type not supported") — closed, named, visible. It is the same criterion as the six
target types without a resolver in the Interaction Framework, for the same reason.

To give a type an owner, from the module's `initialize()`:

```js
inventory.registerAdapter('corpse', {
  applyDelta: (conn, owner, baseId, delta) => /* … */,
  list: (runner, owner) => /* … */,
  assertOwner: (conn, owner) => /* … */    // optional
});
```

The core does not need to know it exists.

### `system` is a closed list

`craft`, `consume`, `gather`, `staff`, `destroy`, `seed`. A new label is an
economy decision and goes through code review — which makes *"which paths
create items on this server?"* answerable by reading.

---

## 6. The API

```js
await inventory.transfer({
  from: inventory.character(12, 0x100),
  to:   inventory.container(3),
  items: [{ baseId: 0x12eb7, quantity: 1 }],
  reason: 'container_deposit',
  module: 'housing',
  requestId: inventory.newRequestId('deposit.12')
});
```

Several legs in a single transaction:

```js
await inventory.exchange({
  legs: [
    { from: A, to: B, items: [/* … */] },
    { from: B, to: A, items: [/* … */] }
  ],
  reason: 'trade', module: 'trade', requestId: `${sessionId}.v${version}`
});
```

### The result has a single shape

```js
{ ok, code, reason, transferId, duplicate, legs, items }
```

It is not a discriminated union on purpose: this package's `jsconfig.json` runs with
`strictNullChecks: false` (deliberately — turning on `strict` would produce hundreds
of errors in the existing code), and without it TypeScript does not narrow
`{ok:true}|{ok:false}`. An API whose correct use lights up `npm run typecheck` is
an API that teaches people to ignore the checker.

`code` is stable and is meant for branching: `INVALID_QUANTITY`, `INVALID_ITEM`,
`UNKNOWN_FORMID`, `INVALID_REQUEST_ID`, `SAME_OWNER`, `NO_ADAPTER`, `TOO_MANY`,
`EMPTY`, `OWNER_NOT_FOUND`, `INSUFFICIENT`, `DB`.

`reason` is the sentence the player may see. **A database error never becomes a `reason`**
— it goes to the log, and the screen gets *"Nao foi possivel concluir a operacao."* ("The operation could not be completed.").
The same fix the stall purchase had already received.

---

## 7. What the pipeline guarantees

### 7.1 Validation, before touching the database

`NaN`, `Infinity`, fractional, negative, zero, above the ceiling, unknown
FormID, malformed `requestId`, source equal to destination, owner without an
adapter. None of this costs a pool connection.

`core/espm.pareceItem` answers **`ok` when it does not know** (no `mp`, old
server): it is a typo diagnostic, not an authority. It only denies when the API
answered and said that FormID does not go into an inventory.

### 7.2 Global lock order

A transfer A→B and another B→A at the same time would lock in opposite order and
deadlock. Operations are sorted by `(owner key, base_id)`, which
gives **every** transfer on the server the same acquisition order — the cycle
becomes impossible instead of improbable.

Deltas for the same `(owner, item)` coming from different legs are summed first:
a trade in which both sides offer the same potion touches one row per side,
not two.

### 7.3 Idempotency that survives a restart

`requestId` is **mandatory**. The first ledger row uses `requestId#0` as the
anchor, and the replay is checked **inside** the transaction with `FOR UPDATE`:

| Situation | Response |
|---|---|
| First call | Executes |
| Second, with the same key | `duplicate: true`, returns the same `transferId`, does not execute |
| Two concurrent calls with the same key | The second **waits** and reads the first one's result |
| Refusal before the commit | The key is **not consumed** — the corrected retry works |

The third row is the fix from audit §7: `giveItem` checked the key
on a different connection from the one opening the transaction, so the second call
received `false` — and a caller with compensation would return an item for an
operation that had succeeded.

This is the layer that protects items. The Interaction Framework's in-memory dedup
protects against double clicks and still exists; the two solve different
things.

### 7.4 The client comes after the commit

Always. A failure in `AddItem`/`RemoveItem` leaves the client divergent and is
reconciled at the next login — it never undoes what was committed.

---

## 8. What this framework does **not** do

- **It does not measure distance.** The interaction pipeline measures it, since it already has actor,
  target and `assertRange`. Measuring here would be measuring at a different moment from the one that
  authorized. The caller revalidates immediately before — `trade-service` does.
- **It does not check permissions.** That belongs to the module that offered the action. This API is the
  notary, not the judge.
- **It does not move gold.** Gold is `core/transaction-service`. Exposing "touch gold
  too" in an item API is how `economy-service` started.
- **It does not impose capacity or weight.** The adapter contract has the place,
  no adapter implements it, and no column supports it. Absent, not
  simulated.
- **It does not reconcile what the client has and the database does not know.** That is the boundary of
  [`ADR_003`](../technical/ADR_003_INVENTORY_SOURCE_OF_TRUTH.md) §3, and it
  remains open.

---

## 9. Who already uses it

| Caller | What changed |
|---|---|
| `housing-service.depositItem` | Was a committed `removeItem()` + two loose `db.query` calls. It could **destroy** items |
| `housing-service.withdrawItem` | **Did not exist.** A chest you can only deposit into is not a chest |
| `crafting-service.craftItem` | Consumption and result in a two-leg `exchange`; the idempotency key no longer contains `Date.now()` |
| `trade-service` | Rewritten entirely on top of `exchange` |
| `market-stalls.addItem` / `packStall` / `removeItem` | The inventory leg entered the stall transaction (they still use `tx.*`, not `inventory`, because the stall is not a stack) |

---

## 10. Database

`migration-v14-inventory-framework.sql`:

- `inventory_transactions.character_id` now accepts `NULL`;
- `owner_type`, `owner_ref`, `counterparty_type`, `counterparty_ref`,
  `transfer_id` and two indexes are added;
- `container_inventory` gains `UNIQUE (container_id, base_id)` — the invariant
  the code assumed and nothing declared. `character_inventory` **already
  had it**, since `migration-v7-indexes.sql`;
- pre-existing duplicates in the chest are **summed**, not discarded: losing
  player stock in a migration is worse than the duplicate being fixed.

⚠️ `check-schema-drift.js` does not recognize `MODIFY COLUMN`. A database that skipped
this migration does not show up as divergent; check by hand with
`SHOW COLUMNS FROM inventory_transactions LIKE 'character_id'`.

---

## 11. What is NOT done

- **Four of the seven owner types have no adapter.** By choice (§5).
- **Instances and metadata do not exist.** By choice (§4.2).
- **Capacity and weight do not exist.**
- **There is no UI.** Not for inventory, chest or trade — the chat
  commands are the entire interface. §18 of the request (reusable components
  `InventoryView`/`ContainerView`/`TradeView`/`CraftingView`) was not
  built: building four screens against a server that has never received a
  player would choose the UI design before knowing what the scene needs to
  show. What exists on the server side is the data format —
  `inventory.list(owner)` returns `[{baseId, count}]` for any owner, which is
  the single model the four screens would share.
- **`container` has no interaction target resolver.** Opening a chest is still
  a direct call to `housing-service`, which is PARKED.
- **None of this has run in a real session.**
