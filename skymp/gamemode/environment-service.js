/**
 * environment-service.js
 *
 * **Time Sync.** The server is the authority over `GameTime`/`TimeScale`: it advances the
 * world clock in memory, corrects client drift on a heartbeat and
 * persists the state to survive a restart without the world "going back in
 * time". The full 15 points of Constitution §15 are in
 * `docs/technical/ENVIRONMENT_AUDIT.md` — this header follows the same narrative
 * pattern as `profession-service.js`, not an embedded checklist (see the note
 * in that file about where §15 really lives).
 *
 * ─── What this file explicitly does NOT do ──────────────────────────────────
 *
 * No weather. `ForceWeather` has no confirmed binding in the SkyMP API
 * (`types/mp.d.ts` declares no `Weather`/`WorldTime`) and `docs/MODDING_GUIDELINES.md`
 * already records smooth transitions as an open question, not an answer. The
 * technical candidate and the risks are in
 * `docs/technical/ENVIRONMENT_WEATHER_SPIKE.md` — no code, on purpose.
 *
 * ─── Where the clock's authority lives ──────────────────────────────────────
 *
 * The IN-MEMORY STATE is the only authority while the process is up.
 * `_tick` never reads the DB to decide the next value — only `initialize()`
 * reads it, once, at boot. That is what guarantees that a DB write failure
 * during the process's life NEVER makes `gameDaysPassed` go backwards: the worst
 * consequence of a failed persist is the next restart resuming from a
 * slightly earlier point, never the clock running backwards while the world
 * is running. See `_persist` below.
 *
 * ─── Constitution §A.6 and why the heartbeat lives in here ─────────────────
 *
 * §A.6 asks for "the world tick" to run outside the SkyMP process, because the
 * simulation in §12 (weather → economy → crime → politics, cascading) is expensive
 * and cannot run during a scene. This service is not that simulation: it is a
 * light heartbeat (same I/O cost as `core/connection-monitor.js`, which already
 * runs a 2s `setInterval` inside the process) that only advances a number and
 * corrects the client. If a future phase really wires weather→economy into this
 * here, THAT chain has to move to an external process — not the clock.
 *
 * ─── Client correction: blocked at the binding, not at the FormDesc ────────
 *
 * A previous version of this file assumed `_applyCorrection` would work
 * as soon as someone confirmed the FormDesc of `GameDaysPassed`/`TimeScale` in
 * CreationKit/xEdit. That was wrong: `core/skymp-adapter/papyrus-catalog.js`
 * — the list extracted from the upstream server's C++ (`UPSTREAM_COMMIT`) — **does not
 * list `GlobalVariable.SetValue`/`GetValue`**. SkyMP does not implement that
 * call; that file's header is explicit about the consequence: calling
 * a function outside the list does not throw, the VM logs an error and returns `null`, and that is
 * how `death-service.js` once knocked everyone down with
 * `Actor.GetActorValue`. Confirming the FormDesc would solve nothing — the native
 * function does not exist in this build, with the right FormDesc or the wrong one.
 *
 * That is why `_applyCorrection` uses `papyrus.isKnownPapyrusFunction` to
 * refuse the call BEFORE trying (it does not trust `callPapyrusFunction` to
 * "just work"), logs once, and corrects no client. The
 * authoritative clock in `getWorldTime()` stays correct — only the
 * *client-side* correction is blocked. `Utility.GetCurrentGameTime` **is** on the
 * list (a read, not a write) — a future correction path would have to
 * compare the client's reading with `getWorldTime()` and act some other way
 * (e.g. a custom Papyrus script on the mod side, outside this service's scope),
 * not write the global directly via Papyrus.
 */

'use strict';

const database = require('./database');
const moduleRegistry = require('./core/module-registry');
const papyrus = require('./core/skymp-adapter/papyrus-catalog');

const MODULE_ID = 'environment';

const DAY_MS = 86400000;
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_PERSIST_EVERY_N_TICKS = 15; // ~30s with a 2s heartbeat
const DEFAULT_TIMESCALE = 20; // Skyrim's vanilla default

/**
 * The Papyrus call that would correct the client's clock, if SkyMP
 * implemented it. Kept named (instead of inline in `_applyCorrection`)
 * so that `isKnownPapyrusFunction` and a possible future upstream have a
 * single place to check — see the header note on why this is
 * blocked today.
 */
const CORRECTION_CALL = Object.freeze({ callType: 'method', className: 'GlobalVariable', functionName: 'SetValue' });

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    mp: dependencies.mp !== undefined ? dependencies.mp : (typeof mp !== 'undefined' ? mp : undefined),
    now: dependencies.now || (() => Date.now()),
    logger: dependencies.logger || console
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state — the only authority during the process's life
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{gameDaysPassed:number, timeScale:number, lastTickAt:number|null}|null} */
let _state = null;
let _timer = null;
let _ticksSinceLastPersist = 0;

function _resetForTest() {
  _state = null;
  _timer = null;
  _ticksSinceLastPersist = 0;
  _warnedUnsupported = false;
}

function _rowToState(row) {
  return {
    gameDaysPassed: Number(row.game_days_passed),
    timeScale: Number(row.timescale),
    lastTickAt: null
  };
}

/**
 * Reads the single row from the DB. Creates it with the default (or `INITIAL_TIMESCALE`) if
 * it does not exist yet — that only happens on the server's FIRST boot.
 * @param {object} deps
 * @param {number} initialTimeScale
 */
async function _loadState(deps, initialTimeScale) {
  const rows = await deps.db.query('SELECT * FROM world_time_state WHERE id = 1', []);
  if (rows.length > 0) return _rowToState(rows[0]);

  await deps.db.query(
    'INSERT INTO world_time_state (id, game_days_passed, timescale) VALUES (1, 0, ?)',
    [initialTimeScale]
  );
  return { gameDaysPassed: 0, timeScale: initialTimeScale, lastTickAt: null };
}

/**
 * Persists the current state. A failure here NEVER changes `_state` — the next
 * attempt is the next tick that hits the persistence interval. That is what
 * makes "time does not go backwards on a DB failure" true: the failure only
 * delays what the NEXT restart will read, never what is running now.
 * @param {object} deps
 */
async function _persist(deps) {
  try {
    await deps.db.query(
      'UPDATE world_time_state SET game_days_passed = ?, timescale = ? WHERE id = 1',
      [_state.gameDaysPassed, _state.timeScale]
    );
  } catch (err) {
    deps.logger.error(`[environment] Failed to persist world_time_state (will retry next cycle): ${err.message}`);
  }
}

let _warnedUnsupported = false;

/**
 * Applies the drift correction on the clients. Refuses BEFORE calling
 * `mp.callPapyrusFunction` if the function is not in `papyrus-catalog.js` —
 * `GlobalVariable.SetValue` is not: this SkyMP build does not implement it, and
 * calling it anyway would not throw, it would just silently return `null` (see the
 * file header). The authoritative clock (`getWorldTime()`) stays
 * correct either way — only the client-side correction becomes unavailable.
 * @param {object} deps
 */
function _applyCorrection(deps) {
  if (typeof deps.mp === 'undefined' || !deps.mp) return;

  const { callType, className, functionName } = CORRECTION_CALL;
  if (!papyrus.isKnownPapyrusFunction(callType, className, functionName)) {
    if (!_warnedUnsupported) {
      _warnedUnsupported = true;
      deps.logger.warn(
        `[environment] ${className}.${functionName} is not in papyrus-catalog.js (build ${papyrus.UPSTREAM_COMMIT}) — ` +
        'this SkyMP does not implement the call. The server clock stays correct; ' +
        'no client receives drift correction until an alternative path exists.'
      );
    }
    return;
  }

  // Unreachable while papyrus-catalog.js does not list the function — kept
  // for when (if) a future upstream starts implementing it.
  try {
    deps.mp.callPapyrusFunction(callType, className, functionName, /* GameDaysPassed */ null, [_state.gameDaysPassed]);
    deps.mp.callPapyrusFunction(callType, className, functionName, /* TimeScale */ null, [_state.timeScale]);
  } catch (err) {
    deps.logger.error(`[environment] Failed to apply drift correction: ${err.message}`);
  }
}

/**
 * One heartbeat: advances `gameDaysPassed` in proportion to the real time
 * elapsed and to `timeScale`, corrects the clients, and persists every N ticks.
 * Exposed separately from `start()`/`stop()` so the test can call it directly, without
 * depending on a real timer — same pattern as `core/connection-monitor.js`.
 * @param {object} [dependencies]
 */
async function _tick(dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_state) return;

  const nowMs = deps.now();
  const elapsedMs = _state.lastTickAt === null ? 0 : Math.max(0, nowMs - _state.lastTickAt);
  _state.gameDaysPassed += (elapsedMs / DAY_MS) * _state.timeScale;
  _state.lastTickAt = nowMs;

  _applyCorrection(deps);

  _ticksSinceLastPersist += 1;
  if (_ticksSinceLastPersist >= DEFAULT_PERSIST_EVERY_N_TICKS) {
    _ticksSinceLastPersist = 0;
    await _persist(deps);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pure read of the in-memory state. `null` before `initialize()`.
 * @param {object} [dependencies]
 */
function getWorldTime(dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return null;
  if (!_state) return null;
  return { gameDaysPassed: _state.gameDaysPassed, timeScale: _state.timeScale };
}

/**
 * @param {object} [dependencies]
 * @param {number} [heartbeatMs]
 */
async function initialize(dependencies = {}, heartbeatMs = DEFAULT_HEARTBEAT_MS) {
  const deps = _deps(dependencies);

  const envTimeScale = Number(process.env.INITIAL_TIMESCALE);
  const initialTimeScale = Number.isFinite(envTimeScale) && envTimeScale > 0 ? envTimeScale : DEFAULT_TIMESCALE;

  _state = await _loadState(deps, initialTimeScale);
  _state.lastTickAt = deps.now();
  _ticksSinceLastPersist = 0;

  if (_timer) return;
  _timer = setInterval(() => {
    _tick(dependencies).catch((err) => deps.logger.error(`[environment] Heartbeat error: ${err.message}`));
  }, heartbeatMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

/**
 * @param {object} [dependencies]
 */
async function shutdown(dependencies = {}) {
  const deps = _deps(dependencies);
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_state) await _persist(deps);
}

function healthCheck() {
  return _state !== null && _timer !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player command — read only
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: ['/time', '/tempo'],
      description: 'Shows the current day and time in the world',
      usage: '/time',
      handler: async (actorId) => {
        const commands = require('./commands');
        const estado = getWorldTime();
        if (!estado) {
          commands.sendNotification(actorId, '[Time] Environment service disabled.');
          return;
        }
        const dia = Math.floor(estado.gameDaysPassed);
        const horaFracionaria = (estado.gameDaysPassed - dia) * 24;
        const hora = Math.floor(horaFracionaria);
        const minuto = Math.floor((horaFracionaria - hora) * 60);
        commands.sendNotification(
          actorId,
          `[Time] Day ${dia}, ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} ` +
          `(TimeScale ${estado.timeScale})`
        );
      }
    }
  ];
}

module.exports = {
  MODULE_ID,
  DAY_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PERSIST_EVERY_N_TICKS,
  DEFAULT_TIMESCALE,
  CORRECTION_CALL,
  getWorldTime,
  initialize,
  shutdown,
  healthCheck,
  commandDefs,
  // Exposed only for tests.
  _tick,
  _resetForTest
};
