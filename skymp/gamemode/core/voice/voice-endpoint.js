/**
 * core/voice/voice-endpoint.js
 *
 * VoiceEndpoint — **who captures the microphone, and nothing else.**
 *
 * ## The problem this abstraction exists to solve
 *
 * Today the project has a single voice path, and it knows too much about itself: the
 * `voip-service.js` knows the PCM format on the wire, the `sender` role, the
 * base64 cap and the WebSocket relay. None of that is a *voice rule* — it is a detail of
 * **how that specific microphone reaches the server**.
 *
 * The migration to LiveKit swaps exactly that detail, and it can be swapped
 * in two ways that cannot yet be chosen between with data:
 *
 *   - **CEF**: `getUserMedia` inside the game UI, publishing with LiveKit's JS
 *     SDK. It depends on the client exposing a safe `CefPermissionHandler` —
 *     technically possible in the CEF 108 SkyMP uses (audit §5), but it
 *     requires a client build of our own.
 *   - **Native**: WASAPI in `voice-helper/`, publishing with LiveKit's C++
 *     SDK. It does not depend on any client patch, and it is Plan B if the
 *     CEF path does not close safely.
 *
 * If the rest of the system asks "is it CEF or native?", every new answer
 * spreads an `if` across one more file, and the choice between A and B becomes a
 * refactor instead of a configuration change. This module is the seam that
 * prevents that: the rest of the system asks about **capabilities**, never **identity**.
 *
 * ## What still belongs to SkyMP, and not to the endpoint
 *
 * The endpoint says where the microphone bytes come from. It does **not** decide:
 *
 *   - who hears whom (proximity — `voip-service.tickProximity`);
 *   - at what volume (same math, same `VOICE_RANGES` table);
 *   - whether the person is muted (`muted`, which belongs to the actor);
 *   - the voice mode's range (`voiceMode`).
 *
 * That is a world rule, it is the game server's authority, and it does not change when the
 * transport changes. LiveKit carries; SkyMP rules. See
 * `docs/technical/SKYVOICE_LIVEKIT_AUDIT.md` §7.
 *
 * ## Status
 *
 * This is **migration scaffolding**, declared now so the CEF-vs-
 * native decision does not have to be made ahead of time. Only `legacy-relay` has a
 * real implementation today; the two LiveKit endpoints describe the contract
 * the implementation will have to fulfill, and are exercised by the spike in
 * `spikes/skyvoice-livekit/`. Nothing here captures audio by itself.
 */

/**
 * How audio gets from a person's microphone to the rest of the world.
 * @typedef {'ws-pcm-relay'|'livekit-sfu'} VoiceTransport
 */

/**
 * Where the microphone is opened.
 * @typedef {'cef'|'native-helper'} VoiceCaptureSite
 */

/**
 * Descriptor of a voice endpoint.
 *
 * It is deliberately a frozen data object, not a class with methods
 * to override. An endpoint does not *do* anything here — it **declares** what it requires
 * and what it offers, and whoever acts (the voice service, the token issuer, the
 * launcher) reads that declaration. Inheritance would give each endpoint a place to
 * hide behavior, which is exactly what this seam wants to avoid.
 *
 * @typedef {object} VoiceEndpoint
 * @property {string} id
 * @property {VoiceTransport} transport
 * @property {VoiceCaptureSite} capturesAt
 * @property {boolean} requiresClientPatch    requires a client build of ours?
 * @property {boolean} requiresExternalProcess requires a process outside the game?
 * @property {boolean} carriesAudioThroughGameServer  does audio go through the game server?
 * @property {boolean} implemented            is there an implementation today?
 * @property {string} rationale               why this endpoint exists
 */

/**
 * The current path: native helper → WebSocket → `voip-service` → UI.
 *
 * `carriesAudioThroughGameServer: true` is the property the rest of the system
 * really needs to know about it, and it is the one that hurts: the gamemode's Node process
 * multiplies each frame by the audience. It is the cost recorded in
 * `TASK_005_VOIP_CAPACITY_AND_SECURITY.md`, and it is why the migration exists.
 */
const LEGACY_RELAY = Object.freeze({
  id: 'legacy-relay',
  transport: 'ws-pcm-relay',
  capturesAt: 'native-helper',
  requiresClientPatch: false,
  requiresExternalProcess: true,
  carriesAudioThroughGameServer: true,
  implemented: true,
  rationale:
    'Path proven up to the transport (VOICE_NATIVE_HELPER.md §7/§8.4). ' +
    'Does not scale: raw PCM re-serialized per listener, inside the game process.'
});

/**
 * Plan A: capture in the game UI, inside the CEF, publishing to LiveKit.
 *
 * `requiresClientPatch: true` is the only reason this is not obviously the
 * chosen one. SkyMP's CEF 108 **has** the API to grant the microphone with
 * scope (`CefPermissionHandler::OnRequestMediaAccessPermission`, verified in
 * audit §5), but the official client's `OverlayClient` does not implement it — and
 * without implementing it the alloy runtime's default is to deny. Using this requires
 * shipping a client of our own.
 *
 * Not to be confused with the discarded patch in `VOICE_CLIENT_PATCH.md`: that one turned on
 * global command-line flags that unlock the microphone **and the camera** for
 * **any origin**. This endpoint assumes the opposite — a handler that
 * answers origin by origin and only grants `AUDIO_CAPTURE`.
 */
const CEF_LIVEKIT = Object.freeze({
  id: 'cef-livekit',
  transport: 'livekit-sfu',
  capturesAt: 'cef',
  requiresClientPatch: true,
  requiresExternalProcess: false,
  carriesAudioThroughGameServer: false,
  implemented: false,
  rationale:
    'No extra process for the player. Requires an origin-scoped CefPermissionHandler ' +
    'granting only AUDIO_CAPTURE, in a client build of our own.'
});

/**
 * Plan B: WASAPI in `voice-helper/`, publishing with LiveKit's C++ SDK.
 *
 * It exists because Plan A depends on a client build, and a plan that depends
 * on something we do not have yet is not a plan — it is a bet. This one reuses the
 * `voice-helper/` that already compiles and has already captured real audio (VOICE_NATIVE_HELPER
 * §8.4): what changes is where the frames go, not how they are captured.
 *
 * It is also why `voice-helper/` is not deleted in this migration.
 */
const NATIVE_LIVEKIT = Object.freeze({
  id: 'native-livekit',
  transport: 'livekit-sfu',
  capturesAt: 'native-helper',
  requiresClientPatch: false,
  requiresExternalProcess: true,
  carriesAudioThroughGameServer: false,
  implemented: false,
  rationale:
    'Does not depend on a client build. Reuses the WASAPI capture already proven ' +
    'in voice-helper, switching the frames\' destination to LiveKit\'s C++ SDK.'
});

const ENDPOINTS = Object.freeze({
  [LEGACY_RELAY.id]: LEGACY_RELAY,
  [CEF_LIVEKIT.id]: CEF_LIVEKIT,
  [NATIVE_LIVEKIT.id]: NATIVE_LIVEKIT
});

/** Voice backends selectable through `VOICE_BACKEND`. */
const BACKENDS = Object.freeze({
  legacy: Object.freeze({
    id: 'legacy',
    endpoints: Object.freeze([LEGACY_RELAY.id])
  }),
  livekit: Object.freeze({
    id: 'livekit',
    // The two LiveKit endpoints coexist on purpose: the room is the same and the
    // transport is the same, so a player with a patched client and another with the
    // native helper hear each other without either one knowing about the other. That
    // property is what allows migrating without a cutover — and it is what would be lost if
    // the rest of the system asked "CEF or native?".
    endpoints: Object.freeze([CEF_LIVEKIT.id, NATIVE_LIVEKIT.id])
  })
});

const DEFAULT_BACKEND = 'legacy';

/**
 * Voice backend in effect, read from `VOICE_BACKEND`.
 *
 * **Default `legacy`, and it is read on every call.** The default is the path that already
 * exists because a migration that starts switched on is not a migration, it is a swap:
 * whoever configured nothing stays exactly where they were. And reading on every call,
 * instead of once at load, is for the same reason as `VOIP_DEBUG_EXPOSE_TICKET` —
 * a flag that only changes by restarting the server is a flag someone leaves in the
 * wrong state to avoid restarting again.
 *
 * An unknown value falls back to the default **and warns**. Falling back silently would let a
 * typo (`VOICE_BACKEND=livekt`) run the whole server on the old backend
 * with everyone thinking it migrated.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'legacy'|'livekit'}
 */
function resolveBackend(env = process.env) {
  const raw = env.VOICE_BACKEND;
  if (raw === undefined || raw === '') return DEFAULT_BACKEND;
  if (Object.prototype.hasOwnProperty.call(BACKENDS, raw)) {
    return /** @type {'legacy'|'livekit'} */ (raw);
  }
  console.warn(
    `[voice] VOICE_BACKEND='${raw}' is not a known backend ` +
    `(${Object.keys(BACKENDS).join(', ')}); using '${DEFAULT_BACKEND}'.`
  );
  return DEFAULT_BACKEND;
}

/**
 * The endpoints allowed by the backend in effect.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {VoiceEndpoint[]}
 */
function activeEndpoints(env = process.env) {
  return BACKENDS[resolveBackend(env)].endpoints.map((id) => ENDPOINTS[id]);
}

/**
 * True when audio still goes through the game server's process.
 *
 * This is the **only** question `voip-service` needs to ask to know whether it
 * should behave as a relay, and it is about a property of the transport —
 * not about which endpoint is active. That difference is what keeps the
 * CEF-vs-native decision out of the rest of the code.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function relaysAudioThroughGameServer(env = process.env) {
  return activeEndpoints(env).some((e) => e.carriesAudioThroughGameServer);
}

/**
 * True when some active endpoint does not have an implementation yet.
 *
 * It exists so boot can say so out loud. Turning on `VOICE_BACKEND=livekit`
 * today means asking for a path that does not capture audio yet; the server should start
 * anyway (that is what makes the spike possible) and should be explicit about what
 * the person just turned on.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function hasUnimplementedEndpoint(env = process.env) {
  return activeEndpoints(env).some((e) => !e.implemented);
}

/**
 * Human-readable summary of the voice state, for the boot log and diagnostics.
 * @param {NodeJS.ProcessEnv} [env]
 */
function describeBackend(env = process.env) {
  const backend = resolveBackend(env);
  const endpoints = activeEndpoints(env);
  return {
    backend,
    endpoints: endpoints.map((e) => e.id),
    relaysAudioThroughGameServer: relaysAudioThroughGameServer(env),
    ready: endpoints.every((e) => e.implemented)
  };
}

module.exports = {
  LEGACY_RELAY,
  CEF_LIVEKIT,
  NATIVE_LIVEKIT,
  ENDPOINTS,
  BACKENDS,
  DEFAULT_BACKEND,
  resolveBackend,
  activeEndpoints,
  relaysAudioThroughGameServer,
  hasUnimplementedEndpoint,
  describeBackend
};
