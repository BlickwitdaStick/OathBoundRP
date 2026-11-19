# Module System

File: [`core/module-registry.js`](../../skymp/gamemode/core/module-registry.js) · Tests: [`core/module-registry.test.js`](../../skymp/gamemode/core/module-registry.test.js) (19 cases)

A module is a unit that can be turned on, turned off and replaced without the rest of the server knowing. It declares what it needs; the registry decides whether and when it comes up.

---

## 1. The descriptor

```js
moduleRegistry.register({
  id: 'market-stalls',                          // unique
  enabledBy: 'ENABLE_MARKET_STALLS_SERVICE',    // env var; only 'true' turns it on
  phase: 'core' | 'lab' | 'parked',
  version: '1.1.0',

  dependencies: ['governance', 'interaction'],  // without them, it does not come up
  optionalDependencies: ['economy-regional'],   // queried if present

  commands: marketStalls.commandDefs(),         // registered/removed automatically

  initialize: async () => { ... },
  shutdown: async () => { ... },
  healthCheck: () => boolean
});
```

`enabledBy` is mandatory and the comparison is `=== 'true'`. Absent counts as off — and that is how every `lab` module is born.

---

## 2. Lifecycle

```
REGISTERED ──► DISABLED           (env flag absent or ≠ 'true')
     │
     ├───────► FAILED             (missing dependency, or initialize threw)
     │
     └───────► INITIALIZING ──► READY ──► RUNNING
                                             │
                                             ▼
                                         STOPPING ──► STOPPED
```

`getState(id)` returns the state; `isEnabled(id)` still answers only "is it running?".

**The distinction that matters is `DISABLED` × `FAILED`.** Until 2026-08-13 the state was a `Set`: two states for five situations, and the two that got confused were exactly these. `isEnabled()` answers `false` for both, and only one is an incident — a server with `governance` broken at boot looked, to any code and to `list()`, like a server that simply did not want governance.

`FAILED` is also the state the Interaction Framework needs: a module that registered interactions and then failed would leave actions in the menu pointing at a service that never initialized. That is why boot clears the interaction registrations of whoever fails.

---

## 3. Dependencies

### Topological ordering

`bootAll()` sorts before bringing things up. Every dependency — mandatory or optional — comes before whatever depends on it, **regardless of registration order**.

This fixes a latent bug. Before, boot walked the modules in insertion order and only considered a dependency satisfied if it had already been initialized in an earlier iteration. It worked because `phase0-basic.js` registers `governance` before `market-stalls`; moving that block twenty lines up turned the module off with

```
market-stalls: FAILED — inactive dependencies: governance
```

— a correct message about a state that should not exist. It was an invisible dependency at the module layer, with the aggravating factor that the failure mode was silent: the log told the truth and nobody read it.

### Mandatory × optional

|  | Mandatory | Optional |
|---|---|---|
| Absent or off | The module **fails** | The module comes up normally |
| Present | Comes up first | Comes up first |
| Declares what | "I do not work without it" | "I use it if it exists" |

`optionalDependencies` exists because of a real case: `governance` queries `economy-regional` if it is on, and solved that with `moduleRegistry.isEnabled()` + `require` inside a `try`, in the middle of a domain function. Declaring it takes the decision out of there.

The boot log shows the inactive optionals:

```
[module-registry] [LAB] governance@1.1.0: ACTIVE (18 commands registered, inactive optionals: economy-regional)
```

### Cycles

A cycle is a programmer error, not a runtime condition. The modules involved are **named** and left out of the boot; the server does not hang, the rest comes up, and the order does not become luck.

```
[module-registry] Dependency CYCLE: a → b → a. Modules involved are left out of the boot.
```

---

## 4. What the registry does on its own

| At boot | At shutdown |
|---|---|
| Sorts by dependency | **Reverse** order |
| Checks the env flag | — |
| Checks mandatory dependencies | — |
| Calls `initialize()` | Calls `shutdown()` |
| Registers `commands[]` in the `command-registry` | Removes `commands[]` |
| — | Removes the module's interactions |
| Removes the interactions of whoever **failed** midway | — |

The reverse shutdown matters: without it, `governance` could leave while `market-stalls` — which consumes it — is still serving requests.

An error in one module's `shutdown` does not prevent the others from shutting down, and the module that failed to shut down **does not remain "active"**.

---

## 5. The three phases

| Phase | Means | Is it in `phase0-basic.js`? |
|---|---|---|
| `core` | Infrastructure. No gameplay of its own | Yes |
| `lab` | Mechanic under validation. **Off by default** | Yes |
| `parked` | Exists on disk, **never registered** | No |

**PARKED is not "off".** An off module has a descriptor and a flag set to `false`; a PARKED module has no descriptor at all. Reactivating it means writing the descriptor — which requires reviewing what parked it.

`CONTRIBUTING.md` §3.3 is explicit: never import a PARKED module directly. `moduleRegistry.isEnabled()` is the gate, and it only answers `true` for a module the registry actually initialized.

PARKED today: `economy-regional`, `housing-service`, `horse-service` (they only appear in a comment in `phase0-basic.js`, without `moduleRegistry.register`). `jobs-service`, `crafting-service` and `trade-service` are **no longer PARKED** — they have a registered descriptor (`id: 'jobs'` / `id: 'crafting'` / `id: 'trade'`) in `phase0-basic.js`, behind `ENABLE_JOBS_SERVICE`/`ENABLE_CRAFTING_SERVICE`/`ENABLE_TRADE_SERVICE` (born `false`); jobs/crafting came out on 2026-08-20 (see `PARKED_SERVICES_DECISION.md` §"Third round"), and trade was already registered before that.

---

## 6. Registering a new module

1. Write the service in `skymp/gamemode/`.
2. Add the descriptor in `phase0-basic.js`, phase `lab`, flag `ENABLE_<NAME>`.
3. Declare `dependencies: ['interaction']` if it registers interactions.
4. Document the flag in `.env.example`.
5. Write the test. `npm test` runs the whole suite.

There is no need to think about the block's position in the file: topological ordering takes care of it.

---

## 7. Diagnostics

```js
moduleRegistry.list()
// [{ id, phase, version, state, enabled, enabledBy, envValue,
//    dependencies, optionalDependencies, commandCount }]

moduleRegistry.getState('governance')       // 'RUNNING' | 'FAILED' | 'DISABLED' | ...
moduleRegistry.healthCheckAll()             // [{ id, healthy, error? }]
moduleRegistry.topologicalOrder()           // { ordered, cycles }
```

`healthCheckAll` only looks at what is active and isolates exceptions: a `healthCheck` that throws becomes `{healthy: false, error}`, it does not bring down the report.

---

## 8. What this system deliberately does not do

**It does not distribute game events.** Red House dispatches `onHit`/`onCellChange` to any module that wants to listen. Evaluated on 2026-08-06 and not done: of the registered modules, **one** listens to a game event (`death`, and only `hit`), and `onCellChange` has no consumer at all. A generic dispatch would trade one line for a bus that serves a single consumer, with one live key and one dead key from day one.

The project's own precedent points the way when the case appears: when a second consumer really showed up, the answer was `core/panel-refresh-bus.js` — a small, named bus. `core/death-events.js` was born the same way, for the same reason.

The trigger to reopen it: a second module that needs a game event already captured by another. The full reasoning is in the header of [`module-registry.js`](../../skymp/gamemode/core/module-registry.js).

**It does not inject dependencies.** Modules use explicit `require`. See [`ADR_002`](../technical/ADR_002_INTERACTION_FRAMEWORK.md) §4.
