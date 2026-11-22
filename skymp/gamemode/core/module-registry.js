/**
 * core/module-registry.js
 *
 * Central registry of the module lifecycle.
 *
 * Each module declares:
 *   - id: unique identifier
 *   - enabledBy: environment variable that enables the module (process.env[enabledBy] === 'true')
 *   - phase: 'core' | 'lab' | 'parked' (informational, helps diagnostics)
 *   - dependencies: IDs of other modules that must be active
 *   - commands: list of registered commands (for automatic cleanup)
 *   - actions: list of actions registered in the action-policy
 *   - initialize(path): initialization function
 *   - shutdown(): shutdown function (optional)
 *   - healthCheck(): health check function (optional, returns boolean)
 *
 * Flow:
 *   1. Modules call moduleRegistry.register(descriptor) when loaded
 *   2. phase0-basic.js calls moduleRegistry.bootAll() at startup
 *   3. bootAll() checks the env var, resolves dependencies and calls initialize()
 *   4. Commands are registered in the commandRegistry automatically if the module is active
 *   5. On disconnect/shutdown, shutdown() is called and commands are removed
 *
 * ─── Game-event distribution: POSTPONED, and why ────────────────────────────
 *
 * Red House's module system distributes game events (`onHit`,
 * `onCellChange`) to any module that wants to listen — not only to whoever the
 * event was originally written for. This registry only has a lifecycle
 * (`initialize`/`shutdown`/`healthCheck`), and the study recorded that as
 * "might be worth it one day"
 * (`docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1, "Other things
 * we learned").
 *
 * **Evaluated on 2026-08-06 and deliberately not done.** The census of the six
 * modules registered today (`phase0-basic.js`):
 *
 *   | module        | game event it would listen to |
 *   |---------------|------------------------------|
 *   | death         | hit — and only that           |
 *   | governance    | none                          |
 *   | market-stalls | none                          |
 *   | player-panel  | none (it polls Papyrus and subscribes to the panel-refresh-bus, which is internal, not a game event) |
 *   | voip          | none                          |
 *   | npc-cleaner   | none                          |
 *
 * **One consumer, one event type.** `core/hit-events.js` hands the episode
 * directly to the subscriber `death-service` passes in `hitEvents.start(cb)` —
 * one line, no indirection. A generic dispatch here would swap that line for
 * a bus that serves a single consumer, and `descriptor.on = { hit, cellChange }`
 * would have one live key and one dead one from day one.
 *
 * `onCellChange` **has no consumer at all**, not even one: `safe-zones.js`
 * queries `mp.get(actorId, 'locationalData')` on demand — it is a property
 * read, served from the server's cache, without the cost of a Papyrus round trip —, and the
 * territory system that would motivate the event is in "Post-Alpha" in
 * `HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md`. Building the distribution because of
 * it would be building infrastructure for a feature that has not yet gone through
 * the 15 questions of Constitution §15.
 *
 * The project's own precedent says the same: when a second consumer
 * really showed up — governance needing to notify the panel —, the answer was
 * `core/panel-refresh-bus.js`, a small, named bus, not a generic
 * channel in the registry. It serves as the model if a third case shows up.
 *
 * **The trigger for reopening this**, for whoever gets here later: a second
 * module that needs a game event already captured by another one. Then the design
 * is an optional `descriptor.on = { hit: fn, cellChange: fn }` in `register()`,
 * dispatched from where the event is already captured today
 * (`core/hit-events.js`), with a test following the pattern of the rest of this file. Until then,
 * generalizing would be premature abstraction — the same one §15 asks to avoid in the
 * world-mechanics layer, for the same reason.
 */

const commandRegistry = require('./command-registry');
const interactionRegistry = require('./interaction-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle (2026-08-13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Possible states of a module.
 *
 * ─── Why this stopped being a `Set` ─────────────────────────────────────────
 *
 * Until now the state was "it is in `_active` or not". Two states, for five
 * distinct situations — and two of them got confused in a way that matters:
 * a module **disabled by env flag** and a module that **failed to
 * initialize** gave the same answer to `isEnabled()`, which is `false`.
 *
 * The difference is operational. The first is the normal state of every `lab` module
 * on this server; the second is an incident. A server with `governance`
 * broken at boot looked, to any code and to `list()`, like a server
 * that simply did not want governance.
 *
 * `FAILED` is also the state the Interaction Framework needs to distinguish: a
 * module that registered interactions and then failed would leave actions in the menu
 * pointing to a service that never initialized. That is why `bootAll`
 * clears the interactions registered by whoever fails.
 */
const STATES = Object.freeze({
  REGISTERED: 'REGISTERED',
  DISABLED: 'DISABLED',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  FAILED: 'FAILED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED'
});

// ─────────────────────────────────────────────────────────────────────────────
// Registro interno
// ─────────────────────────────────────────────────────────────────────────────

// Map of id → full descriptor
const _modules = new Map();

// Modules that were initialized successfully
const _active = new Set();

// Map of id → one of STATES
const _states = new Map();

/**
 * Orders the modules so that every dependency comes before whoever depends
 * on it, regardless of the order in which they were registered.
 *
 * ─── The bug this fixes ─────────────────────────────────────────────────────
 *
 * `bootAll` walked `_modules` in insertion order and checked
 * `dependencies.filter(dep => !_active.has(dep))` — meaning a dependency only
 * counted as satisfied if it **had already been initialized in a previous
 * iteration**. It worked because `phase0-basic.js` registers `governance` before
 * `market-stalls`. Moving that block twenty lines up disabled the module
 * with "inactive dependencies: governance" — a correct message about a
 * state that should not exist.
 *
 * A cycle is a programmer error, not a runtime condition: the modules involved
 * are named and left out of boot, instead of the server hanging or the
 * order becoming luck.
 *
 * @returns {{ordered: string[], cycles: string[]}}
 */
function topologicalOrder() {
  const ordered = [];
  const cycles = [];
  const visitState = new Map(); // id → 'visiting' | 'done'

  function visit(id, path) {
    const state = visitState.get(id);
    if (state === 'done') return true;
    if (state === 'visiting') {
      cycles.push([...path.slice(path.indexOf(id)), id].join(' → '));
      return false;
    }
    const mod = _modules.get(id);
    if (!mod) return true; // dependency on an unregistered module: handled at boot

    visitState.set(id, 'visiting');
    path.push(id);
    let ok = true;
    // Required and optional ones go into the ordering: the optional one is not required
    // to switch on, but if it is on it has to be ready first.
    for (const dep of [...mod.dependencies, ...mod.optionalDependencies]) {
      if (!visit(dep, path)) ok = false;
    }
    path.pop();
    visitState.set(id, 'done');
    if (ok) ordered.push(id);
    return ok;
  }

  for (const id of _modules.keys()) visit(id, []);
  return { ordered, cycles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a module in the registry.
 * Must be called when the module file loads, before bootAll().
 *
 * @param {object} descriptor
 * @param {string}   descriptor.id           - unique module ID (e.g. 'woodcutting')
 * @param {string}   descriptor.enabledBy    - name of the env var that enables this module
 * @param {string}   [descriptor.phase]      - 'core' | 'lab' | 'parked' (default: 'parked')
 * @param {string}   [descriptor.version]    - module version (informational, shows up in diagnostics)
 * @param {string[]} [descriptor.dependencies] - IDs of required modules
 * @param {string[]} [descriptor.optionalDependencies] - IDs consulted only if they are active
 * @param {object[]} [descriptor.commands]   - [{ name, handler, opts }]
 * @param {Function} descriptor.initialize   - async () => void
 * @param {Function} [descriptor.shutdown]   - async () => void
 * @param {Function} [descriptor.healthCheck] - () => boolean
 */
function register(descriptor) {
  const {
    id,
    enabledBy,
    phase = 'parked',
    version = '0.0.0',
    dependencies = [],
    // Declaring what is optional takes the decision out of a domain
    // function. The real case is `governance`, which consults `economy-regional` if
    // it is on and used to solve that with `isEnabled()` + `require` inside
    // a `try`, in the middle of `getInteractionActions`.
    optionalDependencies = [],
    commands = [],
    initialize,
    shutdown = async () => {},
    healthCheck = () => true
  } = descriptor;

  if (!id) throw new Error('[module-registry] Module has no id');
  if (!enabledBy) throw new Error(`[module-registry] Module '${id}' has no enabledBy`);
  if (typeof initialize !== 'function') throw new Error(`[module-registry] Module '${id}' has no initialize function`);
  if (_modules.has(id)) throw new Error(`[module-registry] Module '${id}' registered twice`);

  _modules.set(id, {
    id, enabledBy, phase, version,
    dependencies, optionalDependencies,
    commands, initialize, shutdown, healthCheck
  });
  _states.set(id, STATES.REGISTERED);
}

/**
 * Checks whether a module is active (was initialized successfully).
 * @param {string} id
 * @returns {boolean}
 */
function isEnabled(id) {
  return _active.has(id);
}

/**
 * Commands of modules that are switched off (or failed to start). Without this
 * a player typing `/stalls` on a server with market stalls off got "Unknown
 * command", indistinguishable from a typo.
 * @type {Map<string, {module: string, enabledBy: string}>}
 */
const _unavailableCommands = new Map();

function rememberUnavailable(mod, id) {
  for (const cmdDef of mod.commands || []) {
    const names = Array.isArray(cmdDef.name) ? cmdDef.name : [cmdDef.name];
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const normalized = name.toLowerCase().startsWith('/') ? name.toLowerCase() : `/${name.toLowerCase()}`;
      _unavailableCommands.set(normalized, { module: id, enabledBy: mod.enabledBy });
    }
  }
}

/** `{module, enabledBy}` when `command` belongs to a module that is off, else null. */
function unavailableCommand(command) {
  if (typeof command !== 'string') return null;
  return _unavailableCommands.get(command.toLowerCase()) || null;
}

/**
 * Estado atual de um módulo, ou `null` se ele nem foi registrado.
 *
 * Unlike `isEnabled`, this tells **disabled by flag** apart from **failed
 * to initialize** — both answer `false` there, and only one is an incident.
 *
 * @param {string} id
 * @returns {string|null}
 */
function getState(id) {
  return _states.get(id) || null;
}

/**
 * Initializes every registered module whose env vars are on.
 * Resolves dependencies and registers commands automatically.
 *
 * Must be called ONCE at boot (phase0-basic.js).
 */
async function bootAll() {
  console.log('[module-registry] Starting module boot...');

  const results = { enabled: [], disabled: [], failed: [], order: [] };

  const { ordered, cycles } = topologicalOrder();
  for (const cycle of cycles) {
    console.error(`[module-registry] Dependency CYCLE: ${cycle}. The modules involved are left out of boot.`);
  }
  results.order = ordered;

  for (const id of ordered) {
    const mod = _modules.get(id);
    const shouldEnable = process.env[mod.enabledBy] === 'true';

    if (!shouldEnable) {
      console.log(`[module-registry] [${mod.phase.toUpperCase()}] ${id}: DISABLED (${mod.enabledBy}=false or not set)`);
      _states.set(id, STATES.DISABLED);
      results.disabled.push(id);
      rememberUnavailable(mod, id);
      continue;
    }

    // Required dependencies. The topological ordering above already guarantees
    // every dependency was *attempted* before this line, so an empty `_active`
    // here means it is disabled or failed — never that its turn has not
    // come yet, which was the old failure mode.
    const missingDeps = mod.dependencies.filter(dep => !_active.has(dep));
    if (missingDeps.length > 0) {
      console.error(`[module-registry] ${id}: FAILED — inactive dependencies: ${missingDeps.join(', ')}`);
      _states.set(id, STATES.FAILED);
      results.failed.push({ id, reason: `dependências ausentes: ${missingDeps.join(', ')}` });
      rememberUnavailable(mod, id);
      continue;
    }

    // Inicializar
    _states.set(id, STATES.INITIALIZING);
    try {
      await mod.initialize();
      _states.set(id, STATES.READY);
      _active.add(id);

      // Registrar comandos no command-registry
      for (const cmdDef of mod.commands) {
        commandRegistry.register(cmdDef.name, cmdDef.handler, {
          module: id,
          phase: mod.phase,
          description: cmdDef.description || '',
          usage: cmdDef.usage || cmdDef.name,
          hidden: cmdDef.hidden
        });
      }

      _states.set(id, STATES.RUNNING);
      const inativas = mod.optionalDependencies.filter(dep => !_active.has(dep));
      console.log(
        `[module-registry] [${mod.phase.toUpperCase()}] ${id}@${mod.version}: ACTIVE ` +
        `(${mod.commands.length} commands registered` +
        `${inativas.length > 0 ? `, inactive optional deps: ${inativas.join(', ')}` : ''})`
      );
      results.enabled.push(id);
    } catch (err) {
      // A module that failed in the middle of `initialize` may have already registered
      // interactions. Leaving them in the registry is worse than the failure itself: they
      // show up in the menu and run against a service that never initialized.
      const orfas = interactionRegistry.unregisterModule(id);
      console.error(
        `[module-registry] ${id}: FAILED to initialize:`, err.message +
        (orfas > 0 ? ` (${orfas} orphaned interactions removed)` : '')
      );
      _states.set(id, STATES.FAILED);
      results.failed.push({ id, reason: err.message });
      rememberUnavailable(mod, id);
    }
  }

  console.log(`[module-registry] Boot complete: ${results.enabled.length} active, ${results.disabled.length} disabled, ${results.failed.length} failed`);
  if (results.failed.length > 0) {
    console.error('[module-registry] Failed modules:', results.failed.map(f => `${f.id} (${f.reason})`).join('; '));
  }

  return results;
}

/**
 * Shuts down every active module in order.
 *
 * Reverse boot order: whoever depends on someone shuts down before whoever is
 * depended on. Without this, `governance` could leave while `market-stalls` — which
 * consumes it — is still serving requests.
 *
 * Called on server shutdown.
 */
async function shutdownAll() {
  console.log('[module-registry] Starting module shutdown...');
  const { ordered } = topologicalOrder();
  for (const id of [...ordered].reverse()) {
    const mod = _modules.get(id);
    if (!mod || !_active.has(id)) continue;
    _states.set(id, STATES.STOPPING);
    try {
      // Remover comandos do registry
      for (const cmdDef of mod.commands) {
        commandRegistry.unregister(cmdDef.name);
      }
      // And the registered interactions. Automatic for the same reason the
      // commands are: a module that has to remember to clean up ends up forgetting,
      // and the result is a menu action pointing to a shut-down service.
      interactionRegistry.unregisterModule(id);
      await mod.shutdown();
      _active.delete(id);
      _states.set(id, STATES.STOPPED);
      console.log(`[module-registry] ${id}: shut down`);
    } catch (err) {
      console.error(`[module-registry] Error shutting down ${id}:`, err.message);
      _states.set(id, STATES.FAILED);
      _active.delete(id);
    }
  }
}

/**
 * Runs healthCheck on every active module.
 * Returns a report for diagnostics.
 */
function healthCheckAll() {
  const report = [];
  for (const [id, mod] of _modules.entries()) {
    if (!_active.has(id)) continue;
    try {
      const healthy = mod.healthCheck();
      report.push({ id, healthy });
    } catch (err) {
      report.push({ id, healthy: false, error: err.message });
    }
  }
  return report;
}

/**
 * Lists every registered module with its status.
 */
function list() {
  return Array.from(_modules.values()).map(mod => ({
    id: mod.id,
    phase: mod.phase,
    version: mod.version,
    state: _states.get(mod.id) || STATES.REGISTERED,
    enabled: _active.has(mod.id),
    enabledBy: mod.enabledBy,
    envValue: process.env[mod.enabledBy] || 'not set',
    dependencies: mod.dependencies,
    optionalDependencies: mod.optionalDependencies,
    commandCount: mod.commands.length
  }));
}

/** Test only: resets the registry to empty between cases. */
function _reset() {
  _modules.clear();
  _active.clear();
  _states.clear();
  _unavailableCommands.clear();
}

module.exports = {
  STATES,
  register, isEnabled, getState, unavailableCommand,
  bootAll, shutdownAll, healthCheckAll, list,
  topologicalOrder,
  _reset
};
