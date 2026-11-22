/**
 * core/skymp-adapter/index.js
 *
 * The declared boundary between the gamemode and the SkyMP engine.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * `mp` is a global that accepts any property and returns `undefined` for
 * any naming mistake. So does the tests' mocked `mp`. Between the two, a
 * wrong call goes through the whole suite without touching anything.
 *
 * The 2026-08-14 audit found six defects of that shape
 * (docs/research/SKYMP_INTEGRATION_AUDIT.md). Five are the same disease: the
 * boundary is not an object, it is an unwritten convention.
 *
 * This module covers **only what that audit proved unstable**:
 *
 *   - identity    — `userId` (connection slot) versus `actorId` (FormID);
 *   - Papyrus     — a call checked against what the server's VM implements;
 *   - capability  — `supports()` answers whether the API exists on this server.
 *
 * And it deliberately does **not** cover `get`, `set`, `makeProperty`, `place` or
 * `lookupEspmRecordById`. They are stable, never caused trouble, and wrapping them would only
 * add indirection. Briefing §8 says it plainly: an adapter
 * for an unstable boundary, not a wrapper for every function.
 *
 * ─── How to use it ───────────────────────────────────────────────────────────
 *
 *     const adapter = require('./core/skymp-adapter');
 *     adapter.kick(actorId);                 // converts to userId by itself
 *     adapter.supports('espmLoadOrder');     // false on an old server
 *
 * In tests, inject the fake `mp` instead of touching the global:
 *
 *     const { createAdapter } = require('./core/skymp-adapter');
 *     const adapter = createAdapter({ mp: fakeMp });
 */

'use strict';

const { isKnownPapyrusFunction, UPSTREAM_COMMIT } = require('./papyrus-catalog');

/**
 * **Detectable** capabilities: they are methods of the `mp` object, so it is possible to
 * ask whether they exist.
 *
 * @type {Record<string, string>}
 */
const CAPABILITY_METHODS = {
  espmLoadOrder: 'getEspmLoadOrder',
  neighborsByPosition: 'getNeighborsByPosition',
  userByActor: 'getUserByActor',
  clientEventSource: 'makeEventSource',
  customPacket: 'sendCustomPacket',
  registerPapyrusFunction: 'registerPapyrusFunction',
  papyrusReflection: '_sp3GetFunctionImplementation',
  headlessBot: 'createBot',
  packetHistory: 'getPacketHistory',
  prometheusMetrics: 'getPrometheusMetrics'
};

/**
 * **Non-detectable** capabilities, and the reason for each one.
 *
 * A gamemode hook is a property that *we* assign: `typeof mp.onDeath` is
 * always `'undefined'` before we write it, and always `'function'` after.
 * Asking answers nothing. What is known comes from reading upstream at the
 * commit pinned in `patches/manifest.json`.
 *
 * Declaring that explicitly is better than faking detection: whoever reads knows that
 * the answer comes from a document, not from the server.
 *
 * @type {Record<string, {value: boolean, why: string}>}
 */
const DECLARED_CAPABILITIES = {
  nativeDeathEvent: {
    value: true,
    why: 'DeathEvent.cpp registers "onDeath"; it carries the killer in killerId'
  },
  nativeRespawnEvent: {
    value: true,
    why: 'RespawnEvent.cpp registers "onRespawn"'
  },
  loginAttemptHook: {
    value: true,
    why: 'login.ts calls mp.onLoginAttempt(profileId) before spawning; false refuses'
  },
  equipmentVeto: {
    value: true,
    why: 'UpdateEquipmentAttemptEvent.cpp registers "onUpdateEquipmentAttempt"'
  },
  appearanceVeto: {
    value: true,
    why: 'UpdateAppearanceAttemptEvent.cpp registers "onUpdateAppearanceAttempt"'
  },
  playerSpawnHook: {
    value: false,
    why: 'spawn.ts resolves the spawn by itself. mp._onSpawnAllowed exists but overriding it does not intercept: the EventEmitter keeps the reference to the original function'
  },
  cellTransitionEvent: {
    value: false,
    why: 'there is no cell event in gamemode_events/. Use getActorCellOrWorld or a client event source'
  },
  eslPlugins: {
    value: false,
    why: 'libespm does not handle light plugins. FormDesc::ToFormId is one-byte index arithmetic'
  }
};

/** Boundary error: its own name so it is not confused with a domain error. */
class SkympBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkympBoundaryError';
  }
}

/**
 * @param {object}  [deps]
 * @param {any}     [deps.mp]      the `mp` object; the global by default
 * @param {boolean} [deps.strict]  true (default) makes an unknown Papyrus call
 *                                 throw instead of silently returning `null`
 * @param {{warn: Function, error: Function}} [deps.logger]
 */
function createAdapter({ mp: mpApi, strict = true, logger = console } = {}) {
  // Resolved on every call, not at creation: the gamemode is loaded by
  // SkyMP with `globalThis.mp` already in place, but tests load this module
  // before any `mp` exists. Pinning it at `require` time would yield `undefined`
  // forever.
  const mpDe = () => (mpApi !== undefined ? mpApi : (typeof mp !== 'undefined' ? mp : undefined));

  const has = (nome) => {
    const mp = mpDe();
    return Boolean(mp) && typeof mp[nome] === 'function';
  };

  /** VM reflection cache: `${callType}:${class}.${function}` → boolean. */
  const cacheDeReflexao = new Map();

  /**
   * Does the API exist on this server?
   *
   * Names from `CAPABILITY_METHODS` are asked of `mp`. Names from
   * `DECLARED_CAPABILITIES` come from reading upstream — see the comment there.
   *
   * @param {string} capability
   * @returns {boolean}
   */
  function supports(capability) {
    if (Object.prototype.hasOwnProperty.call(CAPABILITY_METHODS, capability)) {
      return has(CAPABILITY_METHODS[capability]);
    }
    if (Object.prototype.hasOwnProperty.call(DECLARED_CAPABILITIES, capability)) {
      return DECLARED_CAPABILITIES[capability].value;
    }
    throw new SkympBoundaryError(
      `unknown capability "${capability}". ` +
      'Add it to CAPABILITY_METHODS (detectable) or DECLARED_CAPABILITIES (read from upstream).'
    );
  }

  /**
   * Why a capability is what it is. It exists so the boot log states the reason
   * instead of just the boolean.
   *
   * @param {string} capability
   * @returns {string}
   */
  function explain(capability) {
    if (Object.prototype.hasOwnProperty.call(CAPABILITY_METHODS, capability)) {
      const metodo = CAPABILITY_METHODS[capability];
      return has(metodo)
        ? `mp.${metodo} exists`
        : `mp.${metodo} missing on this server`;
    }
    if (Object.prototype.hasOwnProperty.call(DECLARED_CAPABILITIES, capability)) {
      return `${DECLARED_CAPABILITIES[capability].why} (read at ${UPSTREAM_COMMIT.slice(0, 8)})`;
    }
    throw new SkympBoundaryError(`unknown capability "${capability}"`);
  }

  /** Every capability and its value. For the boot log. */
  function capabilities() {
    const saida = {};
    for (const nome of Object.keys(CAPABILITY_METHODS)) saida[nome] = supports(nome);
    for (const nome of Object.keys(DECLARED_CAPABILITIES)) saida[nome] = supports(nome);
    return saida;
  }

  /**
   * Disconnects the player **who owns this actor**.
   *
   * `mp.kick` takes `userId` — the connection slot — and not the FormID:
   *
   *     Napi::Value ScampServer::Kick(const Napi::CallbackInfo& info) {
   *       auto userId = info[0].As<Napi::Number>().Uint32Value();
   *       server->CloseConnection(userId);
   *     }
   *
   * An actor created by the server lives at 0xFF000000+. Passing that to
   * `CloseConnection` closes a slot that does not exist: staff kick, permakill and
   * permadeath silently failed (audit §6).
   *
   * Returns `false` when nobody was connected on that actor — which is a
   * legitimate answer, not an error.
   *
   * @param {number} actorId the actor's FormID
   * @returns {boolean} true if a user was disconnected
   */
  function kick(actorId) {
    const mp = mpDe();
    if (!mp || typeof mp.kick !== 'function') return false;

    if (!Number.isInteger(actorId) || actorId < 0) {
      throw new SkympBoundaryError(`kick: actorId invalido (${actorId})`);
    }

    if (!has('getUserByActor')) {
      // Without the converter there is no way to guess. Refusing is better than guessing:
      // guessing here means disconnecting the wrong person.
      logger.error('[skymp-adapter] mp.getUserByActor missing — kick refused so as not to disconnect the wrong slot.');
      return false;
    }

    const userId = mp.getUserByActor(actorId);
    if (!Number.isInteger(userId) || userId < 0) return false;

    mp.kick(userId);
    return true;
  }

  /**
   * Disconnects by connection slot, when the `userId` is already what you have —
   * `whitelist.js` and `connection-monitor.js` are in that case and always
   * were right.
   *
   * @param {number} userId
   * @returns {boolean}
   */
  function kickUser(userId) {
    const mp = mpDe();
    if (!mp || typeof mp.kick !== 'function') return false;
    if (!Number.isInteger(userId) || userId < 0) {
      throw new SkympBoundaryError(`kickUser: userId invalido (${userId})`);
    }
    mp.kick(userId);
    return true;
  }

  /**
   * Does the Papyrus function exist on this server?
   *
   * Prefers the VM's runtime reflection — which is the truth — and only falls back to the
   * static catalog when it is not available. That is the point of the adapter:
   * the right answer comes from the server, not from a file of ours that ages.
   *
   * @param {'method'|'global'} callType
   * @param {string} className
   * @param {string} functionName
   * @returns {boolean}
   */
  function papyrusFunctionExists(callType, className, functionName) {
    const chave = `${callType}:${className}.${functionName}`.toLowerCase();
    if (cacheDeReflexao.has(chave)) return cacheDeReflexao.get(chave);

    let existe;
    if (has('_sp3GetFunctionImplementation')) {
      try {
        existe = Boolean(mpDe()._sp3GetFunctionImplementation(className, functionName, callType === 'global'));
      } catch (err) {
        logger.warn(`[skymp-adapter] VM reflection failed for ${className}.${functionName}: ${err.message}`);
        existe = isKnownPapyrusFunction(callType, className, functionName);
      }
    } else {
      existe = isKnownPapyrusFunction(callType, className, functionName);
    }

    cacheDeReflexao.set(chave, existe);
    return existe;
  }

  /**
   * Calls Papyrus after checking the name.
   *
   * The VM does not throw when the function does not exist: it logs and returns `VarValue::None()`,
   * which reaches JS as `null`. And `null <= 0` is `true` — that is how
   * `death-service` started knocking down every connected player.
   *
   * In `strict` (default), an unknown name **throws**, with the name in the text.
   * Outside `strict`, it warns and carries on — only useful for diagnostics.
   *
   * @param {'method'|'global'} callType
   * @param {string} className
   * @param {string} functionName
   * @param {object|null} self  `{type, desc}`, never a raw FormID — see core/papyrus.js
   * @param {unknown[]} args
   */
  function callPapyrus(callType, className, functionName, self, args = []) {
    if (callType !== 'method' && callType !== 'global') {
      throw new SkympBoundaryError(`callType must be 'method' or 'global', got "${callType}"`);
    }
    const mp = mpDe();
    if (!mp || typeof mp.callPapyrusFunction !== 'function') {
      throw new SkympBoundaryError('mp.callPapyrusFunction indisponivel');
    }

    if (!papyrusFunctionExists(callType, className, functionName)) {
      const recado =
        `${className}.${functionName} does not exist in the server's Papyrus VM. ` +
        'The call would silently return null. See docs/technical/PAPYRUS_USAGE_POLICY.md';
      if (strict) throw new SkympBoundaryError(recado);
      logger.warn(`[skymp-adapter] ${recado}`);
    }

    return mp.callPapyrusFunction(callType, className, functionName, self, args);
  }

  return {
    supports,
    explain,
    capabilities,
    kick,
    kickUser,
    callPapyrus,
    papyrusFunctionExists,
    SkympBoundaryError
  };
}

/** Single instance bound to the global `mp`. Holds the VM reflection cache. */
const padrao = createAdapter();

module.exports = {
  createAdapter,
  SkympBoundaryError,
  CAPABILITY_METHODS,
  DECLARED_CAPABILITIES,

  supports: padrao.supports,
  explain: padrao.explain,
  capabilities: padrao.capabilities,
  kick: padrao.kick,
  kickUser: padrao.kickUser,
  callPapyrus: padrao.callPapyrus,
  papyrusFunctionExists: padrao.papyrusFunctionExists
};
