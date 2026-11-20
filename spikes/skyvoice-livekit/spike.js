#!/usr/bin/env node
/**
 * SPIKE SkyVoice/LiveKit — transport proof of concept, not a voice implementation.
 *
 * ## What this program proves, and what it cannot prove
 *
 * It connects two participants to a **real** `livekit-server`, publishes a
 * known signal from one side, and measures what comes out on the other. This
 * proves the `A → SFU → B` path using tokens issued by our own code.
 *
 * It does **not** prove that the voice is intelligible, because no program
 * can prove that: intelligibility is a human judgment, not a measurement.
 * See `VOICE_NATIVE_HELPER.md` §8.2 — the same limitation as the legacy path,
 * for the same reason, and it does not go away by switching transports.
 *
 * It also does **not** use Skyrim, CEF, or `voice-helper`. Both participants
 * are Node processes. What is being tested is the transport and the token
 * contract — the two things that needed answers before choosing between
 * Plan A (CEF) and Plan B (native), and which are identical in both plans.
 *
 * ## How to run
 *
 *   1. Start livekit-server (see this directory's README.md)
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

// The token comes from the SAME module used by the gamemode. If the spike had
// its own issuer, it would prove that *one* issuer works — but that is not
// what needs to be proven; it is our own issuer.
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
 * ONLY for the §6 control test — issues a token WITHOUT `canPublishSources`.
 *
 * It exists to prove that camera rejection comes from the permission and not
 * from the `VideoSource`. It deliberately does **not** live in
 * `core/voice/livekit-token.js`: a permissive issuer in production code is
 * a door waiting for someone to call it by mistake. Here it is a measurement
 * instrument, and this entire file is a spike.
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

/** 440Hz tone in mono 48k PCM s16 — a known signal that can be verified mathematically. */
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

/** RMS energy of an s16 sample block, normalized to 0..1. */
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
 * This distinguishes "our tone arrived" from "some noise arrived".
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

/** Incoming audio collector: accumulates samples and counts frames. */
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
    } catch { /* stream closed with the room */ }
  })();
  return stream;
}

async function main() {
  console.log('SPIKE SkyVoice/LiveKit');
  console.log(`  server   : ${URL}`);
  console.log(`  room     : ${ROOM}\n`);

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

  // ── 1. No API secret in the client ─────────────────────────────────────────
  console.log('1. Token and secret');
  record(
    'no API secret inside the token',
    !tokenA.includes(API_SECRET) && !tokenB.includes(API_SECRET),
    'the client receives the signature, never the key used to sign it'
  );
  const payloadA = lkToken.decodePayloadUnsafe(tokenA);
  record('token restricted to ONE room', payloadA.video.room === ROOM, `room=${payloadA.video.room}`);
  record(
    'token only allows microphone publishing',
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
    console.log(`     B subscribed to track from ${participant.identity} (actorId=${actor})`);
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

  // ── 3. Invalid token is rejected ───────────────────────────────────────────
  console.log('\n3. Forged token');
  const forged = lkToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: 'secret_errado_forjado', room: ROOM,
    identity: lkToken.participantIdentity(0xdeadbeef)
  });
  let forgedRejected = false;
  const roomForged = new Room();
  try {
    await roomForged.connect(URL, forged, { autoSubscribe: false });
    await roomForged.disconnect();
  } catch (err) {
    forgedRejected = true;
    record('token signed with the wrong secret is rejected', true, String(err.message).slice(0, 60));
  }
  if (!forgedRejected) record('token signed with the wrong secret is rejected', false, 'ACCEPTED — serious security flaw');

  // ── 4. Publish audio from A ────────────────────────────────────────────────
  console.log('\n4. Audio A → SFU → B');
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('mic-a', source);
  const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  const publication = await roomA.localParticipant.publishTrack(track, opts);
  record('A published a microphone track', Boolean(publication), `sid=${publication.sid}`);

  // The frame pump has a PTT switch separate from its shutdown switch.
  // This distinction matters: releasing PTT **stops capture**; it does not
  // undo the publication — recreating the track for every syllable would
  // require renegotiating with the SFU every time a key is pressed.
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
        // Real silence instead of the tone: Opus with DTX stops transmitting
        // on its own when the input is silence, which is exactly what
        // releasing PTT should produce on the wire.
        const quiet = new Int16Array(SAMPLES_PER_FRAME);
        await source.captureFrame(
          new AudioFrame(quiet, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
        );
      }
    }
  })();

  await sleep(3000);

  record('B subscribed to A''s track', trackSubscribedOnB);
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
    'the energy is concentrated at 440Hz, not spread out',
    ratio > 10,
    `440Hz/1000Hz = ${ratio.toFixed(1)}x`
  );

  // ── 5. PTT and mute ────────────────────────────────────────────────────────
  console.log('\n5. PTT and mute');
  // SDK note, documented here because it is easy to draw the wrong conclusion:
  // `@livekit/rtc-node` exposes `publication.muted` as read-only — there is no
  // `mute()`. Muting from the publishing side is an API provided by the browser
  // **JS SDK** (`localParticipant.setMicrophoneEnabled(false)`) and the server
  // (`MutePublishedTrack`). This is not a LiveKit limitation; it is a limitation
  // of this SDK's API surface, which is why PTT is proven here using the
  // primitive available in both environments: stopping capture.
  pttDown = false;
  await sleep(1500);
  heardOnB.samples.length = 0;
  await sleep(1500);
  const pttUpRms = rms(heardOnB.samples.slice(-SAMPLE_RATE));
  record(
    'PTT released: the signal at B falls to silence',
    pttUpRms < 0.01,
    `RMS ${pttUpRms.toFixed(5)}`
  );

  pttDown = true;
  await sleep(1500);
  const pttDownRms = rms(heardOnB.samples.slice(-SAMPLE_RATE / 2));
  record('PTT pressed: the signal returns', pttDownRms > 0.01, `RMS ${pttDownRms.toFixed(4)}`);

  // Hard mute = removing the publication. B should have no track at all,
  // rather than simply not hearing anything — this is the difference between
  // "I'm not speaking" and "I don't have a microphone in this scene".
  let unsubscribedOnB = false;
  roomB.on(RoomEvent.TrackUnsubscribed, () => { unsubscribedOnB = true; });
  await roomA.localParticipant.unpublishTrack(publication.sid);
  await sleep(1500);
  record('hard mute (unpublish) removes the track on B', unsubscribedOnB);
  record(
    'SDK mute events observed',
    mutedSeenOnB || unmutedSeenOnB || unsubscribedOnB,
    'rtc-node does not emit TrackMuted without a publisher-side mute'
  );

  // ── 6. Camera blocked ──────────────────────────────────────────────────────
  console.log('\n6. Camera');
  // The token declares `canPublishSources: ['microphone']`. The proof is the
  // server rejecting the publication, not the UI refraining from requesting
  // it — relying on the client's goodwill is not a restriction; it is a
  // convention.
  //
  // IMPORTANT: the format of the rejection matters. LiveKit does **not**
  // return a permission error. It ignores the publication and the client
  // eventually times out (~10s). A timeout alone is ambiguous evidence — it
  // could be the `VideoSource` producing no frames, rather than a permission
  // restriction. That is why the control test below is part of the test suite,
  // not a check someone performed once and then discarded.
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
  // Control: an otherwise identical token, except that it does not restrict
  // `canPublishSources`. If THIS one also failed, the test above would not
  // actually be measuring the permission.
  const control = await tryPublishCamera('control', mintPermissiveTokenForControl(ROOM));

  record(
    'restricted token cannot publish a camera',
    restricted.published === false,
    `${restricted.detail} (${restricted.ms}ms)`
  );
  record(
    'CONTROL: the same publish succeeds without the restriction',
    control.published === true,
    control.published
      ? `published in ${control.ms}ms — therefore the rejection above is due to the permission`
      : 'control also failed: the test above does NOT prove permission enforcement'
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
    'A reconnects with a new token and B can hear it again',
    heardOnB.frames > framesBeforeRejoin && rejoinRms > 0.01,
    `RMS ${rejoinRms.toFixed(4)}, +${heardOnB.frames - framesBeforeRejoin} frames`
  );
  record(
    'the reconnection identity is new',
    identityA2 !== identityA,
    'prevents rejoining from terminating the previous session itself'
  );
  record('actorId survives the identity change',
    lkToken.actorIdFromIdentity(identityA2) === ACTOR_A,
    `${lkToken.actorIdFromIdentity(identityA2)} === ${ACTOR_A}`);

  record('connection quality reported by the SFU', qualitySeen !== null,
    qualitySeen !== null ? `value=${qualitySeen}` : 'no event observed');

  // ── 8. LiveKit unavailable ─────────────────────────────────────────────────
  console.log('\n8. LiveKit unavailable');
  // The question is whether the failure can be *caught*. A transport that
  // crashes the process would take the game server down with it — and the
  // game must keep running when voice goes down, not the other way around.
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
  record('unreachable server fails in a catchable way', deadHandled, deadDetail);

  // ── Shutdown ───────────────────────────────────────────────────────────────
  pushing2 = false;
  await pump2.catch(() => {});
  await roomA2.disconnect();
  await roomB.disconnect();

  console.log('\n─────────────────────────────────────────');
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log(`${pass} passed, ${fail} failed, ${results.length} checks`);
  console.log('\nNOT PROVEN by this spike (requires a person/game, not code):');
  console.log('  - voice intelligibility to the human ear');
  console.log('  - two real Skyrim clients');
  console.log('  - capture through CEF or voice-helper');
  console.log('  - unauthorized origin without microphone access (handled by CefPermissionHandler)');
  console.log('  - real-world network conditions: latency, packet loss, and jitter beyond 127.0.0.1');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSPIKE ABORTED:', err);
  process.exit(1);
});