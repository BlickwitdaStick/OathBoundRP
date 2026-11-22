# Test Matrix — Interaction Framework and Module System

**Date:** 2026-08-13 · **Total:** 96 new cases, 646 in the suite (5 from the legacy path left with it) · `npm test` from `skymp/gamemode/`

Files:

| File | Cases | Covers |
|---|---|---|
| [`core/interaction-registry.test.js`](../../skymp/gamemode/core/interaction-registry.test.js) | 23 | Registration, descriptor validation, payload sanitization |
| [`core/interaction-service.test.js`](../../skymp/gamemode/core/interaction-service.test.js) | 50 | The whole pipeline |
| [`core/module-registry.test.js`](../../skymp/gamemode/core/module-registry.test.js) | 19 | Dependencies, lifecycle, cleanup |
| [`identity-service.test.js`](../../skymp/gamemode/identity-service.test.js) | 4 | The `identity.introduce` interaction |

---

## 1. The requested matrix (§21)

| # | Required | Where | Status |
|---|---|---|---|
| 1 | module dependencies | `module-registry.test.js` — *dependency ordering* (7 cases) | ✅ |
| 2 | module lifecycle | `module-registry.test.js` — *lifecycle* (8 cases) | ✅ |
| 3 | interaction registration | `interaction-registry.test.js` — *registration* (8 cases) | ✅ |
| 4 | duplicate action IDs | `interaction-registry.test.js` — *refuses a duplicate id, naming the previous owner* | ✅ |
| 5 | unknown target | `interaction-service.test.js` — *a target type without a resolver fails closed* | ✅ |
| 6 | invalid target | `interaction-service.test.js` — *refuses a nonexistent, malformed and characterless target* | ✅ |
| 7 | distance | `interaction-service.test.js` — *distance out of range refuses* + *marks it as NOT verified* | ✅ |
| 8 | permission | `interaction-service.test.js` — *denies when denied* + *without an injected checker it DENIES* | ✅ |
| 9 | canSee | `interaction-service.test.js` — *an action seen before is worth nothing if canSee changes its mind* | ✅ |
| 10 | canExecute | `interaction-service.test.js` — *canExecute denies what canSee showed* | ✅ |
| 11 | event spoofing | `interaction-service.test.js` — *ignores the client's targetType* + *an undeclared field does not get through* | ✅ |
| 12 | rate limit | `interaction-service.test.js` (2) + `ui-event-rate-limiter.test.js` (2) | ✅ |
| 13 | duplicate request | `interaction-service.test.js` — *requestId, duplicate and replay* (9 cases) | ✅ |
| 14 | player disconnect | `interaction-service.test.js` — *an actor who disconnects is refused before anything else* | ✅ |
| 15 | target disconnect | `interaction-service.test.js` — *a target that disconnects between the query and the execution* | ✅ |
| 16 | UI payload validation | `interaction-registry.test.js` — *payload validation* (9 cases) | ✅ |

---

## 2. The cases that came from real defects

These are not routine coverage. Each one locks a behavior that was wrong, or almost.

| Case | What was wrong |
|---|---|
| *brings up the dependent even when registered BEFORE the dependency* | Boot resolved dependencies in insertion order. `market-stalls` only came up because `phase0-basic.js` registers `governance` first. Moving the block turned it off. |
| *distinguishes DISABLED from FAILED, which isEnabled confuses* | A module turned off by a flag and a module that blew up at boot answered the same thing. One is the normal state of every `lab`; the other is an incident. |
| *removes the interactions of a module that fails in the middle of initialize* | An action registered before the exception would stay in the menu pointing at a service that never initialized. |
| *a double click charges ONCE* | `requestId` was validated for format and discarded. Two fines for one double click. |
| *a refusal before execute does NOT consume the requestId* | The classic error of the naive implementation: marking the id before validating makes the corrected retry get refused as a duplicate. |
| *delivers the event ONLY to the prefix's handler* | The router delivered **every event to every registered handler**. `panel:social:rename` reached governance. |
| *an unknown action and an unavailable action give the SAME response* | Different messages turn the menu into an enumeration oracle for the server. |
| *a guard that throws becomes DENY, not pass* | A buggy `canSee` cannot open anyone's menu. |
| *marks the distance as NOT verified when there was no way to measure it* | `assertRange` without `mp` returned `{ok: true}` — a positive claim about a world nobody measured. |
| *applies a per-type policy without affecting types without a policy* | A single ceiling for `interaction:query` and `interaction:execute` either chokes the first or frees the second. |
| *int: refuses scientific notation, whitespace, decimal and leading zero* | `Number("1e3")` is 1000 and `parseInt(" 1")` is 1. A "can it be converted" validation lets both through. |
| *does not confuse prototype inheritance with a sent field* | `schema.toString` cannot be satisfied by `Object.prototype`. |
| *a number is decimal and a string is hexadecimal* | `"512"` is `0x512`, not 512. Locks the convention the menu already uses and that an innocent change would silently break. |

---

## 3. What is NOT covered, and why

### 3.1 Nothing ran in a real session

**The gap that matters more than all the others combined.** The 96 cases prove the pipeline decides correctly with a mocked `mp`. None of them proves that:

- the `browserModal` with `type: 'interaction:actions'` reaches CEF and is rendered;
- `mp.get(actorId, 'locationalData')` returns what `range-utils` expects, with two clients connected;
- the distance measured in Skyrim units corresponds to what a player calls "close";
- two players clicking the same stall at the same time behave as the concurrency test describes.

It is the same state as `hit-events`, `espm`, `safe-zones`, native voice and the identity tag. `CONSTITUICAO.md` A.1 is explicit: *the worst possible failure here is not bad design — it is continuing to produce excellent documentation of a world that does not exist.*

Where this gets resolved: `FASE_0_ROTEIRO.md`.

### 3.2 CEF — the gap that grew

`skymp/ui/index.html` has no automated test in this project, and on 2026-08-13 its interaction block was **rewritten entirely**: `interaction:query`/`interaction:execute` in place of `governance:interaction:*`, fields built from the server's `schema`, a `requestId` generated on the client, and the removal of `ACTION_CONFIG`, `DEFAULT_INTERACTION_SECTIONS`, `mergeInteractionSections` and `sendChatCommand`.

What was verified: `node --check` on the extracted `<script>` (syntax) and the absence of orphan references via `grep`. **What was not verified is everything else** — not a single line has run inside a CEF. Specifically without proof:

- whether a `browserModal` with `type: 'interaction:actions'` arrives and is dispatched;
- whether the projection of the server's `field.type` (`int`, `string`, `enum`, `bool`, `formid`) onto inputs produces a usable form;
- whether `crypto.randomUUID` exists in SkyrimPlatform's CEF (there is a fallback, and it has never run either);
- whether discarding a response with a swapped target fires when it should.

This is currently the largest unexercised surface of the framework.

### 3.3 The target resolvers that do not exist

`npc`, `object`, `container`, `door`, `property`, `world_point`. What **is** tested is that a request against them fails closed, and that a resolver registered by a module starts working without touching the core.

### 3.4 The domain functions called by `execute`

`stopTarget`, `fineTarget`, `arrestTarget`, `buyItem` have their own tests, in `governance-service.test.js` and `market-stalls-*.test.js`. The matrix here covers **up to** the call — what is inside it is the responsibility of those suites.

### 3.5 Performance

No measurement. §22 of the request says to measure before optimizing, and nothing was measured — not the cost of building a menu with N registered interactions, not `describeFields` per query, not the deduplication sweep.

What is known for free: `query` builds the context **once per candidate interaction**, not once per menu, because each one has its own distance and permission. With 10 interactions registered for `player`, a query is 10 target resolutions and up to 10 permission checks — and governance permission **goes to the database**. If aiming generates continuous queries, this is the first place to measure.

### 3.6 The old path — it left, and its tests did too

Five tests from `governance-service.test.js` were removed along with the code they covered. The equivalence table is in the comment left in their place, and the summary is: everything they locked is still locked, in `core/interaction-service.test.js` and `core/interaction-registry.test.js`, **with one difference that matters** — the `requestId` is now used. The old test checked the format of a field that governance validated and threw away; the new one checks that a double click charges only once.

---

## 4. Running

```bash
npm test
```

```bash
node --test core/interaction-service.test.js
```

```bash
npm run typecheck
```

The typecheck is informative — the gamemode is plain JS loaded directly by SkyMP, with no build step. Errors coming from `node_modules/ws` are known noise.

---

## 5. The warning the CI already carries

> Green CI means nothing that was already verified broke, **not that it works in game**.

It applies fully here, and even more after 2026-08-13: the path players would use was **replaced** by another one that has never run. 646 tests pass. Zero players have used this.
