/**
 * core/proximity-ranges.js
 *
 * Single source of the proximity radii (in Skyrim units).
 *
 * Before this consolidation there were three radius tables that disagreed
 * with each other, and none of them was the authority over the others:
 *
 *   - `rp-chat-service.js`  → whisper 450, say 1200, emote 1500, ooc 2000, shout 3500
 *   - `voip-service.js`     → whisper 200, normal 1200, shout 3000
 *   - `server-options.*.json` → whisperRange 350, localRange 1400, shoutRange 3000
 *
 * The practical effect was a silent RP bug: a player within range of a
 * written whisper was out of range of a spoken whisper, and vice versa —
 * so the same gesture of "lean in to speak quietly" worked or not
 * depending on the channel the person picked.
 *
 * The table below is the one that counts. The values came from `rp-chat-service.js`,
 * the only one of the three that was actually in use and tested.
 *
 * IMPORTANT: the three chat radii come from `server-options.<env>.json` — editing
 * the JSON changes the game. `core/server-options.js` reads, validates and applies
 * the defaults; `emote` and `ooc` are still derived here, on purpose (see the
 * note right below).
 *
 * Until 2026-08-06 this header said the opposite — that nobody read the JSON
 * and that you should "edit here". That was true when `QA_REPORT_2026-08`
 * recorded the finding, and stopped being true when `core/server-options.js` was born;
 * the comment stayed. A stale comment about configuration is the same
 * class of defect as configuration nobody reads: in both cases someone
 * edits one place and the game does not change. Only this one told you to edit the wrong place.
 */

const serverOptions = require('./server-options');

// Three radii come from `chat.*` in server-options; `emote` and `ooc` are derived.
// Deriving instead of configuring is deliberate: they are support channels, and the
// relationship between them and normal speech ("emote reaches a bit further because action is
// visual", "OOC reaches further because it is support, not scene") is a server design
// decision, not a knob each operator should turn on their own.
const say = serverOptions.get('chat.localRange');

const RANGES = Object.freeze({
  /** Whisper: you need to be practically touching. */
  whisper: serverOptions.get('chat.whisperRange'),
  /** Normal speech (`/say`, and proximity voice in normal mode). */
  say,
  /** Emotes (`/me`, `/do`): a bit wider than speech, because action is visual. */
  emote: Math.round((say * 5) / 4),
  /** OOC: wider on purpose, it is a support channel and not a scene one. */
  ooc: Math.round((say * 5) / 3),
  /** Shout: the widest, but still far from global. */
  shout: serverOptions.get('chat.shoutRange')
});

/**
 * Voice radii, per mode. They mirror the chat ones on purpose — `normal` is the
 * same range as `say` so that speaking and writing reach the same people.
 * `emote` and `ooc` do not exist in voice (you do not emote through a microphone).
 */
const VOICE_RANGES = Object.freeze({
  whisper: RANGES.whisper,
  normal: RANGES.say,
  shout: RANGES.shout
});

module.exports = { RANGES, VOICE_RANGES };
