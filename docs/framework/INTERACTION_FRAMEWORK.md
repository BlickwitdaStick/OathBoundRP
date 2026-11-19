# Interaction Framework

**Status:** implemented in LAB; checked on 2026-08-26 with **1,262 gamemode
tests, 1,261 passing and 1 known failure in Safe Zones**. It is the only
generic interaction pipeline; the legacy path was removed on 2026-08-13.
**It has never run in a real session.**

Files:

| File | Responsibility | Touches `mp`/database? |
|---|---|---|
| [`core/interaction-registry.js`](../../skymp/gamemode/core/interaction-registry.js) | Interaction catalog + payload validation | **No** — pure function |
| [`core/interaction-targets.js`](../../skymp/gamemode/core/interaction-targets.js) | Translates the target the client claims into the target the server knows | Only via `range-utils` |
| [`core/interaction-service.js`](../../skymp/gamemode/core/interaction-service.js) | The decision pipeline | No — everything by injection |

---

## 1. The problem

A Heavy RP server needs a player to point at another and see *what makes sense to do with that person, right now*. A guard sees "Search". A doctor sees "Examine". Someone next to a stall sees "Buy". Nobody sees what they cannot do.

This already existed, inside `governance-service.js`, and the **flow was right**. What was wrong was where it lived: for a stall to appear in the menu, governance had to import the stall module by a hardcoded name; the action vocabulary was a regex of three namespaces in the core; and `requestId` was validated and thrown away, so a double click on "Apply fine" charged twice.

Full diagnosis in [`CORE_FRAMEWORK_AUDIT.md`](../research/CORE_FRAMEWORK_AUDIT.md) §6.

---

## 2. The central rule

> **`canSee` authorizes nothing.**

`canSee` decides what appears in a menu built at an earlier moment, on someone else's machine. Between building it and clicking, the target may have walked off, left, been arrested or sold the stall; whoever clicked may have lost their role.

That is why `execute` **redoes the entire pipeline** — resolves the target again, checks permission again, measures distance again — and runs `canExecute` in addition to `canSee`.

No interaction needs to remember to revalidate. The pipeline revalidates.

---

## 3. The pipeline

```
Client (CEF)
    │  interaction:query  |  interaction:execute
    ▼
core/ui-event-gateway.js        envelope + telemetry, never logs the payload
    ▼
core/ui-event-router.js         prefix 'interaction' → and only it
    ▼
core/interaction-service.js
    │
    ├─ 1. rate limit            per-type policy: query ≠ execute
    ├─ 2. known action          unknown = same response as unavailable
    ├─ 3. target                client's targetId → server's record
    ├─ 4. schema                payload sanitized, undeclared fields dropped
    ├─ 5. permission            opaque string, resolved by whoever registered
    ├─ 6. action policy         core/action-policy.js — state + safe zone
    ├─ 7. distance              core/range-utils.js
    ├─ 8. canSee                module code
    ├─ 9. canExecute            module code (execute only)
    ├─ 10. deduplication        requestId, for idempotent actions
    ├─ 11. execute              the module does the work
    └─ 12. audit                by class: TRACE does not write
    ▼
core/transaction-service.js     atomicity and ledger, when moving gold/items
```

### Why this order

- **Rate limit before everything** — its purpose is to not pay for the rest.
- **Target before schema** — a request without a valid target has nothing to validate the payload against.
- **Permission before policy** — *"you are not a guard"* is a better answer than *"you are handcuffed"* for someone who is not a guard.
- **Policy and distance before `canSee`** — both are core rules, `canSee` is module code: the cheap and auditable runs first.
- **Deduplication after all validation** — a request that was going to be refused cannot consume the `requestId`, otherwise the legitimate, already corrected retry would be refused as a duplicate.

---

## 4. Registering an interaction

From your module's `initialize()`:

```js
const interactionRegistry = require('./core/interaction-registry');

interactionRegistry.register({
  id: 'medical.help',                 // <module>.<action>, lowercase
  module: 'medical',                  // owner — used for automatic cleanup
  target: interactionRegistry.TARGET_TYPES.PLAYER,
  label: 'Give first aid',
  section: 'medicina',                // grouping in the menu (default: the module)
  order: 10,                          // lowest first

  distance: 200,                      // Skyrim units; measured by the server
  policyAction: 'medical_help',       // id from core/action-policy.js
  audit: interactionRegistry.AUDIT_LEVELS.GAMEPLAY,
  idempotent: false,                  // true requires requestId and deduplicates

  schema: {
    reason: { type: 'string', label: 'Reason', max: 160 }
  },

  canSee: async ctx => estaFerido(ctx.target.characterId),
  canExecute: async ctx => ({ allowed: temBandagem(ctx.characterId), reason: 'No bandage.' }),
  execute: async ctx => {
    await curar(ctx.target.characterId);
    return { message: 'You stabilized the wounded.' };
  }
});
```

And in the module descriptor, in `phase0-basic.js`:

```js
dependencies: ['interaction'],
```

The `module-registry`'s topological ordering guarantees the framework is ready before your `initialize()`, regardless of the order of the blocks in the file.

**Nothing else needs to be edited.** Not the core, not governance, not the event router. That is §23 of the request.

### The lifecycle is automatic

`shutdownAll()` calls `interactionRegistry.unregisterModule(id)` for every module, for the same reason it removes commands: an action that survives shutdown appears in the menu and executes against a service that is no longer there. A module that fails **in the middle** of `initialize()` also has its interactions removed.

---

## 5. The context delivered to the module

```js
{
  actorId,       // SkyMP actor of whoever acted
  actor,         // the character record the server already had
  characterId,
  accountId,

  target: {      // resolved by the server, never copied from the payload
    type,        // 'player'
    id,          // 'player:512' — stable, for logs and dedupe
    label,
    actorId, characterId, accountId, character,
    assertRange(fromActorId, maxRange)
  },

  interactionId,
  module,
  data,          // payload ALREADY SANITIZED: only the schema fields, already converted
  requestId,     // null when the action is not idempotent
  permission,    // checkPermission's verdict, when there was one
  distanceVerified,
  distanceUnverified
}
```

`data` is a **new** object. A field not declared in the schema does not reach `execute` — that is the difference between validating and sanitizing.

`distanceUnverified` is `true` when `mp` does not exist and there was no way to measure. The pipeline lets it through (that is what makes all of this testable outside the game) but the audit records `distancia=NAO_VERIFICADA` instead of lying that it measured.

---

## 6. Target types

The vocabulary has seven: `PLAYER`, `NPC`, `OBJECT`, `CONTAINER`, `DOOR`, `PROPERTY`, `WORLD_POINT`.

**Only `PLAYER` has an implemented resolver.** The other six are reserved vocabulary, and a request against them fails with *"Tipo de alvo nao suportado"* ("Target type not supported") — closed, named, visible.

Writing the six now would be writing six functions with no caller, against SkyMP APIs this project has never exercised (`mp.get(id,'inventory')` is still marked `[DOC]` in `types/mp.d.ts`). It is the same criterion the `module-registry` used on 2026-08-06 to **not** build game event distribution, and the alternative — six guessed resolvers — is worse than their absence, because it looks finished.

When a type gets an owner:

```js
interactionTargets.registerResolver('container', (rawTargetId, actorId) => {
  const bau = baus.get(String(rawTargetId));
  if (!bau) return null;                       // null = invalid target
  return {
    type: 'container',
    id: `container:${bau.id}`,
    label: bau.nome,
    assertRange: (from, max) => rangeUtils.assertRange(from, bau.actorId, max)
  };
});
```

The core does not need to know it exists.

### Nobody is their own target

Interacting with oneself is the panel (`/painel`), not the context menu. The rule lives in one place only, in the `player` resolver — the previous version had it in governance, and it was the reason the `isSelf` branch of `market-stalls` (`stall.manage`) was never reachable.

### Numbers are decimal, strings are hexadecimal

`512` is 512. `"512"` is `0x512`. `"0x200"` and `"200"` are the same actor.

It is not arbitrary: it is what governance's `parseActorId` always did and what the menu sends (`formatActorId` emits `0x…`). Changing it would break the current UI.

---

## 7. `requestId` and double clicks

An interaction with `idempotent: true` **requires** a `requestId` (8 to 48 characters) and the pipeline deduplicates by `(actorId, requestId)`:

| Situation | Response |
|---|---|
| First call | Executes |
| Second, with the first still running | Refuses: *"already being processed"* |
| Second, after the first finished | Returns **the same result**, without executing (`duplicate: true`) |
| Refusal before `execute` | `requestId` is **not consumed** — the corrected retry works |
| `execute` threw | `requestId` released — retrying is the right client behavior |

It lives in memory (120 s TTL), on purpose. A table would give idempotency across server restarts, at the cost of an `INSERT` on the hot path of every interaction, to protect against a case that does not happen. **The idempotency that needs to survive a restart already exists one layer below**, via `idempotency_key` in `transaction-service` — and that is what protects gold and items. This one protects against double clicks.

Used today by: `law.fine`, `law.arrest`, `law.confiscate`, `stall.buy`.

---

## 8. Auditing

| Class | Writes? | Purpose |
|---|---|---|
| `TRACE` | **No** | Queries and reads — opening a showcase, viewing a menu |
| `GAMEPLAY` | Yes | Changes the world reversibly (default) |
| `SECURITY` | Yes | One player acting on another, without consent |
| `ADMIN` | Yes | Staff power |
| `ECONOMY` | Yes | Moves gold or items |

The default is `GAMEPLAY`: whoever did not choose, writes. Silence is opt-in.

**A refusal does not create a row.** A player clicking a button they cannot use must not fill the table staff use to arbitrate. An `execute` failure does, with the reason.

An audit that fails **does not undo** what already happened: it shouts in the log and moves on.

---

## 9. Rate limit

`core/ui-event-rate-limiter.js` gained per-type policy. The global ceiling is still off by default — the discipline of measuring before limiting has not changed.

| Environment variable | Effect |
|---|---|
| `UI_EVENT_RATE_LIMIT_MAX_EVENTS` | Global ceiling per `(actor, type)`. `0`/absent = measure only |
| `UI_EVENT_RATE_LIMIT_WINDOW_MS` | Global window (default 60 s) |
| `INTERACTION_EXECUTE_RATE_LIMIT` | Ceiling for `interaction:execute` only |

`query` and `execute` have opposite profiles: a query happens on every aim (dozens per minute, cheap, no side effect), an execution moves gold (a few per minute, expensive, irreversible). A single ceiling either chokes the first or frees the second.

There is **one** limiter, shared between the gateway and the framework: two would give the same player two budgets, and the sum would not show up in any metric.

---

## 10. Secrets the pipeline does not tell

Things that look like details and are not:

- **A nonexistent action and an unavailable action give the same response.** Distinguishing them would turn the menu into an enumeration oracle for the server.
- **The list returned to the client carries no permission, range or audit class.** The response is the list of actions; the reasoning belongs to the server.
- **The request's `targetType` is ignored in `execute`** — it comes from the descriptor. Accepting it would allow calling a `player` action while declaring the target as `container` and landing in a resolver that does not make that action's refusals.
- **A `canSee` that throws becomes DENY**, not pass. A buggy module does not open anyone's menu.
- **A `canSee` that returns `undefined` becomes DENY.** Whoever did not decide did not authorize.
- **An interaction with a declared `permission` and no injected checker DENIES**, and shouts in the log.

---

## 11. Events

**UI → server**

```js
{ type: 'interaction:query',   data: { targetType: 'player', targetId: '0x200' } }
{ type: 'interaction:execute', data: { action: 'law.fine', targetId: '0x200',
                                       requestId: 'req-...', data: { amount: 150, reason: '...' } } }
```

`data` is also accepted at the top level (`{action, targetId, amount, reason}`), which is the format the CEF uses today.

**Server → UI**

```js
mp.set(actorId, 'browserModal', {
  type: 'interaction:actions',
  data: {
    target: { type: 'player', id: 'player:512', label: '0x200' },
    targetType: 'player',
    sections: [{
      id: 'guarda', label: 'guarda',
      actions: [{
        action: 'law.fine', label: 'Apply fine',
        requiresRequestId: true,
        fields: [{ name: 'amount', type: 'int', label: 'Amount', required: true, min: 1, max: 100000 }]
      }]
    }]
  }
});
```

The form fields **come from the server**. As long as both sides declare the same fields, the day the server tightens a limit the UI keeps offering the old one, and the player finds out by typing.

The result of `execute` goes out as a notification, not a modal: the result of an action is a sentence, not a screen.

---

## 12. What is already registered

| Interaction | Module | Range | Audit | Idempotent |
|---|---|---|---|---|
| `law.stop` — Stop | governance | 450 | SECURITY | no |
| `law.search` — Search | governance | 350 | SECURITY | no |
| `law.records` — View record | governance | 450 | SECURITY | no |
| `law.fine` — Apply fine | governance | 450 | ECONOMY | **yes** |
| `law.detain` — Detain | governance | 450 | SECURITY | no |
| `law.arrest` — Arrest | governance | **650** | SECURITY | **yes** |
| `law.confiscate` — Confiscate | governance | 450 | ECONOMY | **yes** |
| `law.release` — Release | governance | 450 | SECURITY | no |
| `stall.view` — View showcase | market-stalls | `chat.localRange` | **TRACE** | no |
| `stall.buy` — Buy item | market-stalls | `chat.localRange` | ECONOMY | **yes** |
| `identity.introduce` — Introduce yourself | identity | 450 | **TRACE** | no |
| `mining.mine` — Mine | mining | `mining.maxDistance` | ECONOMY | **yes** |
| `crafting.recipes` / `crafting.craft` | crafting | `crafting.maxDistance` | TRACE/ECONOMY | craft: **yes** |
| `public_work.accept_*` / `pickup` / `deliver` / `cancel` | public-work | `publicWork.maxDistance` | GAMEPLAY/ECONOMY | economic operations: **yes** |

Each `execute` calls the same domain function as always (`stopTarget`, `fineTarget`, `buyItem`, …), **and each one revalidates permission and range on its own**. The redundancy is deliberate: if someone calls `fineTarget` through another path, the check is still there.

Three things changed for these actions:

1. **Distance in `canSee`.** The old menu listed by permission and nothing else, so a guard saw "Arrest" in the menu of someone across the map. `law.arrest` uses 650 (escort), which is the range `arrestTarget` always required internally and that the old menu did not reflect.
2. **Real idempotency** for fines, arrests, confiscations and purchases.
3. **Stall with range.** The showcase appeared for anyone in the same cell, at any distance.

---

## 13. The old path was removed

On 2026-08-13, in the same effort: the legacy left entirely, and this is the only path.

**On the server**, `governance-service.js` lost `getInteractionActions`,
`handleInteractionAction`, `validateUiInteractionPayload`, `isValidUiAction`,
`handleUiEvent` and `sendBrowserModal`; `market-stalls-service.js` lost
`getInteractionSections` and `handleInteractionAction`. `phase0-basic.js` no longer
registers the `governance` prefix in the event router — governance no longer
has its own UI. The domain functions (`stopTarget`, `fineTarget`,
`arrestTarget`, `buyItem`, …) stayed **intact**.

**In the CEF**, `skymp/ui/index.html` speaks `interaction:query` / `interaction:execute`
and lost `ACTION_CONFIG`, `DEFAULT_INTERACTION_SECTIONS`,
`mergeInteractionSections` and `sendChatCommand`. Each form's fields
come from the server's `schema`; the client only draws.

Two behavior changes came along:

- **`stall.manage` left the menu.** It depended on a `self` target, which the framework does not
  allow — and it was already unreachable before, due to a governance refusal
  (`CORE_FRAMEWORK_AUDIT.md` §6.7a). The chat command remains. It comes back to the menu
  when `object`/`container` gets a resolver and the stall becomes a real target.
- **"Introduce yourself" became `identity.introduce`**, a real interaction,
  registered by `commands.js`. It disappears from the menu when the target already knows the
  character: introducing yourself twice is not an error, but it is a button that does
  nothing, and an RP menu that offers empty gestures teaches the player to ignore it.

## 14. What is NOT done
- **Exact physical target acquisition is implemented in LAB, not validated.**
  The client uses `Game.getCurrentCrosshairRef()` + FormID conversion and the
  server determines the type. The proximity path was removed from the
  prompt's authority.
- **The Miner's Blocker D was fixed in code.** It still needs confirmation of
  `crosshairRefChanged`, conversions and the native E behavior in our build
  and in the three-client test; that prevents declaring the feature ready.
- **Reading the published core defined the route adopted in LAB.** Skyrim
  Platform exposes `crosshairRefChanged`, and SkyMP carries E as
  `activate(target, caster)`. The aim polling and the second capture via
  `buttonEvent` were removed; `core/activation-events.js` is now the single
  owner of `mp.onActivate`. The synchronous return still needs to be validated in
  game. The study and the hook's restrictions are in
  [SKYRIM_ROLEPLAY_SKYMP_CORE_STUDY_2026-08-25.md](../research/SKYRIM_ROLEPLAY_SKYMP_CORE_STUDY_2026-08-25.md).
- **The CEF→server gateway was fixed in code, but not validated in the
  real runtime.** Do not confuse the transport fix (Blocker C) with
  target acquisition (Blocker D); they are independent problems.
- **`stall.manage` has no place in the world menu** — it still depends on the
  `self` target. The chat command remains until the stall has its own
  physical reference registered as `object`.
- **None of this has run in a real session.** There is automated coverage, but zero
  players and one known failure in the current suite.
- **The suite is not green in this snapshot.** Safe Zones still does not know the
  `work` category; 1 of 1,262 tests fails because of that divergence.
- **There are two known acquisition gaps.** The Miner treats
  `interaction-prompt` as an optional dependency despite having no command, and
  the Depot registers a provider without updating the synchronous snapshot queried by
  E when no other anchors module is active.
- **The Miner does not yet filter the Resource Node type.** Until it is fixed,
  TREE/HERB/CROP/FISHING can also appear as `mining.mine` and grant Miner
  XP.

### Contract implemented in LAB for world targets

1. the client captures the exact reference under the crosshair when E is pressed;
2. the client converts the FormID to the server's format;
3. the server resolves the object and lists the allowed actions;
4. on execute, the server resolves and validates target, cell, distance,
   state and permission again;
5. an empty, changed or unknown target fails closed — with no fallback to the
   nearest object/player.

The native event does not end validation. The SkyMP core checks the same
worldspace on activation, but does not check distance; that is why step 4 remains
mandatory even when the target comes from `mp.onActivate`.

This contract is implemented once in the framework and must be consumed by the
Miner and [Public Work](../gameplay/PUBLIC_WORK_SYSTEM.md). The status report
and validation order are in
[MINING_RUNTIME_VALIDATION_REPORT.md](../research/MINING_RUNTIME_VALIDATION_REPORT.md).
