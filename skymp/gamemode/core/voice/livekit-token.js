/**
 * core/voice/livekit-token.js
 *
 * Issuing LiveKit access tokens — ALWAYS on the server, never on the client.
 *
 * ## Why this file exists and why it is small
 *
 * A LiveKit access token is an ordinary HS256 JWT: header, payload and an
 * HMAC-SHA256 signature made with the **API secret**. There is nothing proprietary
 * about the format — what is proprietary is the *contents* of the `video` claim.
 *
 * That is why we do not pull in `livekit-server-sdk`. Signing an HS256 JWT is one
 * `crypto.createHmac` call, and the gamemode runs inside the Node embedded by SkyMP,
 * where every new dependency is a dependency someone has to audit,
 * package and update. Same reasoning that made `voice-helper/src/main.cpp`
 * write base64 by hand instead of dragging in yet another vcpkg port.
 *
 * The price of that choice is that the format of the `video` claim is our
 * responsibility. It is pinned by a test against a **real** `livekit-server` — see
 * `spikes/skyvoice-livekit/`, which starts the official server and confirms that the token
 * issued here is accepted. A token that "looks right" and is refused by the server
 * would be exactly the kind of defect compiling does not catch.
 *
 * ## The rule that cannot be broken
 *
 * **The API secret never leaves this process.** It comes in through `LIVEKIT_API_SECRET`,
 * is used to sign, and what travels to the client is the JWT — which is already the
 * result of the signature, not its input. A client with the secret can
 * forge any identity in any room; a client with a JWT can
 * only be who the server said it is, until the token expires.
 *
 * This mirrors what `voip-service.issueTicket` already did on the legacy path: the
 * server issues, the client presents. The only difference is the format of the paper.
 *
 * ## What the token does NOT decide
 *
 * The token grants *access to the transport*. It does not say who hears whom — that is
 * proximity, a world rule, and it belongs to SkyMP (`voip-service.tickProximity`).
 * See `docs/technical/SKYVOICE_LIVEKIT_AUDIT.md` §7.
 */

const crypto = require('crypto');

/**
 * Token lifetime, in seconds.
 *
 * Short on purpose: the token is an entry badge, not a session. The client
 * uses it to open the connection and LiveKit keeps the session alive after that —
 * `exp` does not kick out whoever is already inside, it only prevents a new entry. Six
 * minutes leave room for the handshake and an immediate reconnection without keeping
 * a valid badge forgotten on disk or in a log.
 *
 * A long reconnection (cable dropped, player came back ten minutes later) asks for a new
 * token, and asking is cheap: it is the same path as `/voice`.
 */
const DEFAULT_TTL_SECONDS = 360;

/** Clock skew tolerated backwards on `nbf`. */
const CLOCK_SKEW_SECONDS = 10;

function _b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The participant's identity in LiveKit.
 *
 * **Always derived from the actorId by the server, never chosen by the client.** The
 * identity is what LiveKit repeats to every other participant in the
 * room; if the client could choose it, it would choose someone else's, and
 * everyone would see its voice labeled with someone else's name. It is the same hole the
 * single-use ticket closes in the legacy path's `auth`, and it closes here for the same
 * reason: whoever asserts the identity is whoever already knows who you are.
 *
 * The session suffix exists because LiveKit treats identity as a unique key
 * in the room — a second participant with the same identity **kicks the
 * first one**. Without the suffix, a quick reconnection (before the server notices
 * the previous one died) would kick out the very connection that is coming in.
 *
 * @param {number} actorId
 * @param {string} [sessionNonce] short identifier for this connection attempt
 * @returns {string}
 */
function participantIdentity(actorId, sessionNonce) {
  const nonce = sessionNonce || crypto.randomBytes(4).toString('hex');
  return `actor-${actorId}-${nonce}`;
}

/**
 * Extracts the actorId from an identity issued by `participantIdentity`.
 *
 * It exists for the **receiving** side: when it sees a participant in the room, the client
 * needs to know which actor that voice belongs to in order to apply the proximity
 * gain SkyMP sent. Returns `null` for anything that does not have the
 * format — an identity we do not recognize is not one of our actors, and
 * guessing would be worse than admitting we do not know.
 *
 * @param {string} identity
 * @returns {number|null}
 */
function actorIdFromIdentity(identity) {
  if (typeof identity !== 'string') return null;
  const m = /^actor-(\d+)-[0-9a-f]+$/.exec(identity);
  if (!m) return null;
  const actorId = Number.parseInt(m[1], 10);
  return Number.isFinite(actorId) ? actorId : null;
}

/**
 * Builds and signs a LiveKit access token.
 *
 * @param {object} opts
 * @param {string} opts.apiKey            LIVEKIT_API_KEY
 * @param {string} opts.apiSecret         LIVEKIT_API_SECRET — never leaves here
 * @param {string} opts.room              room (one per voice scene)
 * @param {string} opts.identity          identity — use `participantIdentity`
 * @param {string} [opts.name]            display name (character)
 * @param {boolean} [opts.canPublish]     can speak (default: true)
 * @param {boolean} [opts.canSubscribe]   can listen (default: true)
 * @param {number} [opts.ttlSeconds]
 * @param {number} [opts.now]             injectable by tests
 * @returns {string} compact JWT
 */
function mintAccessToken(opts) {
  const {
    apiKey,
    apiSecret,
    room,
    identity,
    name,
    canPublish = true,
    canSubscribe = true,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    now = Date.now()
  } = opts || {};

  // Fail loudly and early. A token signed with an empty secret is accepted by
  // `createHmac` without complaint and refused by the server later on, far from
  // here — the error would show up as "voice does not connect", which is the most
  // expensive symptom to diagnose.
  if (!apiKey) throw new Error('[livekit-token] missing apiKey');
  if (!apiSecret) throw new Error('[livekit-token] missing apiSecret');
  if (!room) throw new Error('[livekit-token] missing room');
  if (!identity) throw new Error('[livekit-token] missing identity');

  const nowSec = Math.floor(now / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };

  const payload = {
    iss: apiKey,               // who issued it — LiveKit finds the secret through this
    sub: identity,             // LiveKit reads the identity from `sub`
    nbf: nowSec - CLOCK_SKEW_SECONDS,
    exp: nowSec + ttlSeconds,
    jti: crypto.randomBytes(8).toString('hex'),
    ...(name ? { name } : {}),
    video: {
      // `roomJoin` + `room` tie the token to ONE room. Without `room`, a leaked
      // token gets into any voice scene on the server.
      roomJoin: true,
      room,
      canPublish,
      canSubscribe,

      // Denied explicitly, not by omission. These are the rights that
      // would turn a player into a room operator: `roomAdmin` messes with
      // who is inside, `roomCreate` creates rooms outside the
      // gamemode's control, `canPublishData` opens a message channel between clients
      // that SkyMP does not see — and SkyMP is the one that rules the world.
      // Writing `false` instead of omitting it is so that reading the token
      // answers the question, instead of requiring someone to know the default.
      canPublishData: false,
      canUpdateOwnMetadata: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,

      // Audio only. A client with this token that tries to publish video is
      // refused by the server itself, not by the UI's good will — the camera
      // is blocked in two independent layers (here and in the
      // CefPermissionHandler; see the audit §5 and §8).
      canPublishSources: ['microphone']
    }
  };

  const signingInput = `${_b64url(JSON.stringify(header))}.${_b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signingInput).digest();

  return `${signingInput}.${_b64url(signature)}`;
}

/**
 * Decodes a token's payload WITHOUT verifying the signature.
 *
 * For tests and diagnostics only. Do not use this to make an
 * authorization decision: whoever verifies LiveKit token signatures is
 * `livekit-server`, and reimplementing that check here would create a second
 * opinion about who has access — two authorities over the same question is the
 * same defect as the duplicated radius table in `proximity-ranges.js`.
 *
 * @param {string} token
 * @returns {object|null}
 */
function decodePayloadUnsafe(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  mintAccessToken,
  participantIdentity,
  actorIdFromIdentity,
  decodePayloadUnsafe,
  DEFAULT_TTL_SECONDS
};
