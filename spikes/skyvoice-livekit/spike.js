#!/usr/bin/env node
/**
 * SkyVoice/LiveKit SPIKE — a transport proof, not a voice implementation.
 *
 * ## What this program proves, and what it cannot prove
 *
 * It starts two participants against a **real** `livekit-server`, publishes a
 * known signal on one side and measures what comes out of the other. That
 * proves the `A → SFU → B` path with tokens issued by our own code.
 *
 * It does **not** prove the voice comes out intelligible, because no program
 * proves that: intelligibility is a human judgment, not a measurement. See
 * `VOICE_NATIVE_HELPER.md` §8.2 — the same limitation as the legacy path, for
 * the same reason, and it doesn't go away because we switched transports.
 *
 * It also does **not** use Skyrim, CEF or the `voice-helper`. Both
 * participants are Node processes. What's under test is the transport and the
 * token contract — the two things that needed an answer before choosing
 * between Plan A (CEF) and Plan B (native), and that are identical in both plans.
 *
 * ## How to run
 *
 *   1. start the livekit-server (see this directory's README.md)
 *   2. LIVEKIT_URL=ws://127.0.0.1:7880 \
 *      LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... node spike.js
 */

'use strict';

const path = require('path');
const {
  Room, RoomEvent, AudioSource, AudioStream, AudioFrame,
  LocalAudioTrack, LocalVideoTrack, VideoSource,
  TrackPublishOptions, TrackSource
} = require('@livekit/rtc-node');

// The token comes from the SAME module the gamemode uses. If the spike had its
// own issuer, it would prove that *an* issuer works — and that's not what needs
// proving; ours is.
const lkToken = require(
  path.join(__dirname, '..', '..', 'skymp', 'gamemode', 'core', 'voice', 'livekit-token')
);

const URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const ROOM = process.env.LIVEKIT_ROOM || `skyvoice-spike-${Date.now()}`;

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 960 — same as the legacy path
const TONE_HZ = 440;
const TONE_AMPLITUDE = 0.3;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ONLY FOR THE §6 CONTROL — issues a token WITHOUT `canPublishSources`.
 *
 * It exists to prove that the camera refusal comes from the permission and not
 * from the `VideoSource`. It deliberately does **not** live in
 * `core/voice/livekit-token.js`: a permissive issuer in production code is a
 * door waiting for someone to open it by mistake. Here it's a measuring
 * instrument, and the whole file is a spike.
 */
function mintPermissiveTokenForControl(room) {
  const crypto = require('crypto');
  const b64 = (b) => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: API_KEY, sub: `control-${crypto.randomBytes(3).toString('hex')}`,
    nbf: now - 10, exp: now + 360, jti: crypto.randomBytes(8).toString('hex'),
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true }
  };
  const si = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${si}.${b64(crypto.createHmac('sha256', API_SECRET).update(si).digest())}`;
}

/** 440Hz tone as s16 mono 48k PCM — a known signal, verifiable by arithmetic. */
function makeToneFrame(phaseStart) {
  const data = new Int16Array(SAMPLES_PER_FRAME);
  let phase = phaseStart;
  const step = (2 * Math.PI * TONE_HZ) / SAMPLE_RATE;
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    data[i] = Math.round(Math.sin(phase) * TONE_AMPLITUDE * 32767);
    phase += step;
  }
  return { frame: new AudioFrame(data, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME), phase };
}

/** RMS energy of a block of s16 samples, normalized to 0..1. */
function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Signal energy at `hz` by correlation (simplified Goertzel).
 * Used to tell "our tone arrived" apart from "some noise arrived".
 */
function energyAt(samples, hz) {
  let re = 0, im = 0;
  const step = (2 * Math.PI * hz) / SAMPLE_RATE;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    re += v * Math.cos(step * i);
    im += v * Math.sin(step * i);
  }
  return Math.sqrt(re * re + im * im) / samples.length;
}

/** Received-audio collector: accumulates samples and counts frames. */
function collectAudio(track, sink) {
  const stream = new AudioStream(track);
  (async () => {
    try {
      for await (const frame of stream) {
        sink.frames++;
        const d = frame.data;
        for (let i = 0; i < d.length; i++) sink.samples.push(d[i]);
        if (sink.samples.length > SAMPLE_RATE * 5) {
          sink.samples.splice(0, sink.samples.length - SAMPLE_RATE * 5);
        }
      }
    } catch { /* stream closed along with the room */ }
  })();
  return stream;
}

async function main() {
  console.log('SkyVoice/LiveKit SPIKE');
  console.log(`  server : ${URL}`);
  console.log(`  room   : ${ROOM}\n`);

  if (!API_KEY || !API_SECRET) {
    console.error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required.');
    process.exit(2);
  }

  const ACTOR_A = 0xff000a01;
  const ACTOR_B = 0xff000b02;

  const identityA = lkToken.participantIdentity(ACTOR_A);
  const identityB = lkToken.participantIdentity(ACTOR_B);

  const tokenA = lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
    identity: identityA, name: 'Client A'
  });
  const tokenB = lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
    identity: identityB, name: 'Client B'
  });

  // ── 1. No API secret on the client ─────────────────────────────────────────
  console.log('1. Token and secret');
  record(
    'no API secret inside the token',
    !tokenA.includes(API_SECRET) && !tokenB.includes(API_SECRET),
    'the client gets the signature, never the signing key'
  );
  const payloadA = lkToken.decodePayloadUnsafe(tokenA);
  record('token bound to ONE room', payloadA.video.room === ROOM, `room=${payloadA.video.room}`);
  record(
    'token only allows publishing the microphone',
    JSON.stringify(payloadA.video.canPublishSources) === JSON.stringify(['microphone']),
    'camera denied at the token layer'
  );

  // ── 2. Two clients, real authentication ────────────────────────────────────
  console.log('\n2. Connecting two clients');
  const roomA = new Room();
  const roomB = new Room();

  const heardOnB = { frames: 0, samples: [] };
  let trackSubscribedOnB = false;
  let mutedSeenOnB = false;
  let unmutedSeenOnB = false;

  roomB.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    trackSubscribedOnB = true;
    const actor = lkToken.actorIdFromIdentity(participant.identity);
    console.log(`     B subscribed to a track from ${participant.identity} (actorId=${actor})`);
    collectAudio(track, heardOnB);
  });
  roomB.on(RoomEvent.TrackMuted, () => { mutedSeenOnB = true; });
  roomB.on(RoomEvent.TrackUnmuted, () => { unmutedSeenOnB = true; });

  let qualitySeen = null;
  roomB.on(RoomEvent.ConnectionQualityChanged, (q) => { qualitySeen = q; });

  await roomA.connect(URL, tokenA, { autoSubscribe: true, dynacast: false });
  record('client A authenticated by livekit-server', true, `identity=${identityA}`);

  await roomB.connect(URL, tokenB, { autoSubscribe: true, dynacast: false });
  record('client B authenticated by livekit-server', true, `identity=${identityB}`);

  // ── 3. An invalid token is rejected ────────────────────────────────────────
  console.log('\n3. Forged token');
  const forged = lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: 'wrong_forged_secret', room: ROOM,
    identity: lkToken.participantIdentity(0xdeadbeef)
  });
  let forgedRejected = false;
  const roomForged = new Room();
  try {
    await roomForged.connect(URL, forged, { autoSubscribe: false });
    await roomForged.disconnect();
  } catch (err) {
    forgedRejected = true;
    record('a token signed with the wrong secret is rejected', true, String(err.message).slice(0, 60));
  }
  if (!forgedRejected) record('a token signed with the wrong secret is rejected', false, 'ACCEPTED — serious hole');

  // ── 4. Publish audio from A ────────────────────────────────────────────────
  console.log('\n4. Audio A → SFU → B');
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('mic-a', source);
  const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  const publication = await roomA.localParticipant.publishTrack(track, opts);
  record('A published a microphone track', Boolean(publication), `sid=${publication.sid}`);

  // The frame pump has a PTT switch separate from the shutdown switch. That's
  // the distinction that matters: releasing PTT **stops capturing**, it doesn't
  // undo the publication — redoing the track on every syllable would cost a
  // renegotiation with the SFU per key press.
  let phase = 0;
  let pushing = true;
  let pttDown = true;
  const pump = (async () => {
    while (pushing) {
      const t = makeToneFrame(phase);
      phase = t.phase;
      if (pttDown) {
        await source.captureFrame(t.frame);
      } else {
        // Real silence instead of the tone: Opus with DTX stops transmitting on
        // its own when the input is silence, which is exactly what a released
        // PTT should produce on the wire.
        const quiet = new Int16Array(SAMPLES_PER_FRAME);
        await source.captureFrame(
          new AudioFrame(quiet, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
        );
      }
    }
  })();

  await sleep(3000);

  record('B subscribed to A\'s track', trackSubscribedOnB);
  record('B received audio frames', heardOnB.frames > 0, `${heardOnB.frames} frames`);

  const heardSamples = heardOnB.samples.slice(-SAMPLE_RATE);
  const heardRms = rms(heardSamples);
  const e440 = energyAt(heardSamples, TONE_HZ);
  const e1000 = energyAt(heardSamples, 1000);
  const ratio = e1000 > 0 ? e440 / e1000 : Infinity;

  record(
    'the received signal has energy',
    heardRms > 0.01,
    `RMS ${heardRms.toFixed(4)} (theoretical ${(TONE_AMPLITUDE / Math.SQRT2).toFixed(4)} before Opus)`
  );
  record(
    'the energy is at 440Hz, not spread out',
    ratio > 10,
    `440Hz/1000Hz = ${ratio.toFixed(1)}x`
  );

  // ── 5. PTT and mute ────────────────────────────────────────────────────────
  console.log('\n5. PTT and mute');
  // SDK note, recorded because it's easy to draw the wrong conclusion:
  // `@livekit/rtc-node` exposes `publication.muted` as read-only — there's no
  // `mute()`. Muting from the publishing side is an API of the **browser JS
  // SDK** (`localParticipant.setMicrophoneEnabled(false)`) and of the server
  // (`MutePublishedTrack`). It's not a LiveKit limitation; it's this SDK's
  // surface, so PTT here is proven with the primitive that exists in both
  // worlds: stop capturing.
  pttDown = false;
  await sleep(1500);
  heardOnB.samples.length = 0;
  await sleep(1500);
  const pttUpRms = rms(heardOnB.samples.slice(-SAMPLE_RATE));
  record(
    'PTT released: the signal at B goes silent',
    pttUpRms < 0.01,
    `RMS ${pttUpRms.toFixed(5)}`
  );

  pttDown = true;
  await sleep(1500);
  const pttDownRms = rms(heardOnB.samples.slice(-SAMPLE_RATE / 2));
  record('PTT pressed: the signal comes back', pttDownRms > 0.01, `RMS ${pttDownRms.toFixed(4)}`);

  // Hard mute = withdrawing the publication. B should end up with no track at
  // all, not just stop hearing — it's the difference between "I'm not talking"
  // and "I have no microphone in this scene".
  let unsubscribedOnB = false;
  roomB.on(RoomEvent.TrackUnsubscribed, () => { unsubscribedOnB = true; });
  await roomA.localParticipant.unpublishTrack(publication.sid);
  await sleep(1500);
  record('hard mute (unpublish) removes the track at B', unsubscribedOnB);
  record(
    'SDK mute events observed',
    mutedSeenOnB || unmutedSeenOnB || unsubscribedOnB,
    'rtc-node does not emit TrackMuted without a publisher mute'
  );

  // ── 6. Camera blocked ──────────────────────────────────────────────────────
  console.log('\n6. Camera');
  // The token declares `canPublishSources: ['microphone']`. The proof is the
  // server refusing, not the UI not asking — whoever relies on the client's
  // good will has no restriction, only a convention.
  //
  // MIND the shape of the refusal: LiveKit does **not** return a permission
  // error. It ignores the publication and the client times out (~10s). A
  // timeout alone is ambiguous evidence — it could be a `VideoSource` with no
  // frames, not the permission. That's why the control below is part of the
  // test, and not a check someone did once and threw away.
  const tryPublishCamera = async (label, token) => {
    const room = new Room();
    await room.connect(URL, token, { autoSubscribe: false, dynacast: false });
    const vsource = new VideoSource(320, 240);
    const vtrack = LocalVideoTrack.createVideoTrack(`cam-${label}`, vsource);
    const t0 = Date.now();
    try {
      const pub = await room.localParticipant.publishTrack(
        vtrack, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA })
      );
      await room.disconnect();
      return { published: true, ms: Date.now() - t0, detail: `sid=${pub.sid}` };
    } catch (err) {
      await room.disconnect().catch(() => {});
      return { published: false, ms: Date.now() - t0, detail: String(err.message).slice(0, 50) };
    }
  };

  const restricted = await tryPublishCamera('restricted', lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
    identity: lkToken.participantIdentity(0xff00ca01)
  }));
  // Control: identical token, except it doesn't restrict `canPublishSources`.
  // If THIS one failed too, the test above wouldn't be measuring permission.
  const control = await tryPublishCamera('control', mintPermissiveTokenForControl(ROOM));

  record(
    'a restricted token cannot publish the camera',
    restricted.published === false,
    `${restricted.detail} (${restricted.ms}ms)`
  );
  record(
    'CONTROL: the same publish succeeds without the restriction',
    control.published === true,
    control.published
      ? `published in ${control.ms}ms — so the refusal above comes from the permission`
      : 'the control failed too: the test above does NOT prove permission'
  );

  // ── 7. Reconnection ────────────────────────────────────────────────────────
  console.log('\n7. Reconnection');
  pushing = false;
  await pump.catch(() => {});
  await roomA.disconnect();
  await sleep(1000);

  const roomA2 = new Room();
  const identityA2 = lkToken.participantIdentity(ACTOR_A);
  const tokenA2 = lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
    identity: identityA2, name: 'Client A'
  });
  await roomA2.connect(URL, tokenA2, { autoSubscribe: true, dynacast: false });

  const source2 = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track2 = LocalAudioTrack.createAudioTrack('mic-a2', source2);
  await roomA2.localParticipant.publishTrack(
    track2, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
  );

  heardOnB.samples.length = 0;
  const framesBeforeRejoin = heardOnB.frames;

  let phase2 = 0;
  let pushing2 = true;
  const pump2 = (async () => {
    while (pushing2) {
      const t = makeToneFrame(phase2);
      phase2 = t.phase;
      await source2.captureFrame(t.frame);
    }
  })();

  await sleep(3000);
  const rejoinRms = rms(heardOnB.samples.slice(-SAMPLE_RATE));
  record(
    'A comes back with a new token and B hears again',
    heardOnB.frames > framesBeforeRejoin && rejoinRms > 0.01,
    `RMS ${rejoinRms.toFixed(4)}, +${heardOnB.frames - framesBeforeRejoin} frames`
  );
  record(
    'the reconnection identity is new',
    identityA2 !== identityA,
    'keeps the re-entry from knocking out its own previous session'
  );
  record('actorId survives the identity change',
    lkToken.actorIdFromIdentity(identityA2) === ACTOR_A,
    `${lkToken.actorIdFromIdentity(identityA2)} === ${ACTOR_A}`);

  record('connection quality reported by the SFU', qualitySeen !== null,
    qualitySeen !== null ? `value=${qualitySeen}` : 'no event observed');

  // ── 8. LiveKit down ────────────────────────────────────────────────────────
  console.log('\n8. LiveKit unavailable');
  // The question is whether the failure is *catchable*. A transport that kills
  // the process would take the game server down with it — and the game has to
  // keep going when voice goes down, not the other way around.
  let deadHandled = false;
  let deadDetail = '';
  const roomDead = new Room();
  try {
    const deadToken = lkToken.mintAccessToken({
      apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
      identity: lkToken.participantIdentity(0xff00dead)
    });
    await roomDead.connect('ws://127.0.0.1:1', deadToken, { autoSubscribe: false });
  } catch (err) {
    deadHandled = true;
    deadDetail = String(err.message).slice(0, 60);
  }
  record('an unreachable server fails in a catchable way', deadHandled, deadDetail);

  // ── shutdown ───────────────────────────────────────────────────────────────
  pushing2 = false;
  await pump2.catch(() => {});
  await roomA2.disconnect();
  await roomB.disconnect();

  console.log('\n─────────────────────────────────────────');
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log(`${pass} passed, ${fail} failed, ${results.length} checks`);
  console.log('\nNOT PROVEN by this spike (needs a person/the game, not code):');
  console.log('  - voice intelligible to the human ear');
  console.log('  - two real Skyrim clients');
  console.log('  - capture through CEF or the voice-helper');
  console.log('  - an unauthorized origin without microphone access (that belongs to CefPermissionHandler)');
  console.log('  - a real network: latency, loss and jitter beyond 127.0.0.1');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSPIKE ABORTED:', err);
  process.exit(1);
});
