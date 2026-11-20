#!/usr/bin/env node
/**
 * frame-probe.js — uses the same protocol as the native helper, in Node.
 *
 * It exists because the C++ helper and the server relay fail in different
 * ways, and debugging both at the same time is how this project ended up with
 * VOIP that never produced audio. This probe isolates the two halves: if it
 * sends audio and the browser plays it, the problem (if any) is in WASAPI
 * capture, not in the transport, relay, or playback.
 *
 * This is what validated the server and UI in Phase 1 — see
 * docs/technical/VOICE_NATIVE_HELPER.md §7.
 *
 * DOES NOT replace the helper: it does not capture any microphone; it
 * generates a synthetic tone.
 *
 * Usage:
 *   node frame-probe.js --actor-id 0xFF000A12 --ticket <token> [--host h] [--port p]
 *                       [--freq 440] [--seconds 10] [--role sender|listener]
 *   node frame-probe.js --listen --actor-id 0xFF000A13 --ticket <token>
 *
 * The role follows the mode: when generating a tone, it authenticates as
 * `sender` (what the helper does); with `--listen`, it authenticates as
 * `listener` (what the UI does). Since tickets are role-specific, ask the
 * harness for the correct ticket: `/ticket?actorId=…&role=sender`.
 * See docs/technical/VOICE_NATIVE_HELPER.md §10.
 */

// `ws` is resolved from the gamemode, where it is already a declared
// dependency. Having a separate `node_modules` here would mean a second copy
// of the same library that could have a different version in precisely the
// component responsible for testing the protocol.
const path = require('path');
const { createRequire } = require('module');
const gamemodeRequire = createRequire(
  path.resolve(__dirname, '..', '..', 'skymp', 'gamemode', 'package.json')
);
const WebSocket = gamemodeRequire('ws');

// Must match AUDIO_* in voip-service.js and main.cpp in the helper.
const SAMPLE_RATE = 48000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 960

function parseArgs(argv) {
  const opt = {
    host: '127.0.0.1', port: 7778, freq: 440, seconds: 0,
    listen: false, actorId: null, ticket: null, amplitude: 0.3, role: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--listen') opt.listen = true;
    else if (a === '--role') opt.role = argv[++i];
    else if (a === '--actor-id') opt.actorId = Number.parseInt(argv[++i], 0) || Number(argv[i]);
    else if (a === '--ticket') opt.ticket = argv[++i];
    else if (a === '--host') opt.host = argv[++i];
    else if (a === '--port') opt.port = Number.parseInt(argv[++i], 10);
    else if (a === '--freq') opt.freq = Number.parseFloat(argv[++i]);
    else if (a === '--seconds') opt.seconds = Number.parseFloat(argv[++i]);
    else if (a === '--amplitude') opt.amplitude = Number.parseFloat(argv[++i]);
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(opt.actorId) || !opt.ticket) {
    console.error('missing --actor-id and/or --ticket. See this file\'s header.');
    process.exit(2);
  }
  if (opt.role !== null && opt.role !== 'listener' && opt.role !== 'sender') {
    console.error(`invalid --role: ${opt.role} (use 'listener' or 'sender')`);
    process.exit(2);
  }
  return opt;
}

/** Effective role: explicit if provided, otherwise the one implied by the mode. */
function effectiveRole(opt) {
  if (opt.role !== null) return opt.role;
  return opt.listen ? 'listener' : 'sender';
}

/** One 20ms frame of a sine wave, mono 16-bit LE PCM, continuous between frames. */
function makeToneFrame(phase, freq, amplitude) {
  const buf = Buffer.allocUnsafe(SAMPLES_PER_FRAME * 2);
  const step = (2 * Math.PI * freq) / SAMPLE_RATE;
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    // The phase deliberately continues from one frame to the next: resetting
    // it to zero every 20ms would produce a 50Hz click that could mask jitter
    // problems.
    const v = Math.sin(phase + i * step) * amplitude;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return { buf, phase: (phase + SAMPLES_PER_FRAME * step) % (2 * Math.PI) };
}

const opt = parseArgs(process.argv);
const url = `ws://${opt.host}:${opt.port}`;
const ws = new WebSocket(url);

let timer = null;
let sent = 0;
let phase = 0;

ws.on('open', () => {
  console.log(`[probe] connected to ${url}; authenticating as 0x${opt.actorId.toString(16)}`);
  // The role mirrors the mode: the one generating a tone does what the
  // helper does (`sender`), while the one only monitoring does what the UI
  // does (`listener`). This way, the probe exercises the same dual-connection
  // setup as a real player, rather than the arrangement with two distinct
  // actors that Phase 1 used to work around the actorId collision.
  // `--role` overrides this to explicitly test the wrong side.
  ws.send(JSON.stringify({
    type: 'auth', actorId: opt.actorId, ticket: opt.ticket, role: effectiveRole(opt)
  }));
});

const received = new Map(); // fromActorId -> { frames, bytes, volumes:Set }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'auth_ok') {
    console.log('[probe] authenticated.');
    if (opt.listen) { console.log('[probe] listen mode; waiting for audio_frame.'); return; }
    startSending();
    return;
  }

  if (msg.type === 'auth_failed') {
    console.error('[probe] authentication rejected — ticket expired (30s), already used, or belongs to another actor.');
    process.exit(1);
  }

  if (msg.type === 'audio_frame') {
    let s = received.get(msg.fromActorId);
    if (!s) { s = { frames: 0, bytes: 0, volumes: new Set() }; received.set(msg.fromActorId, s); }
    s.frames++;
    s.bytes += Buffer.from(msg.data, 'base64').length;
    s.volumes.add(msg.volume);
    if (s.frames === 1 || s.frames % 50 === 0) {
      console.log(`[probe] <- 0x${msg.fromActorId.toString(16)}: ${s.frames} frames, ` +
                  `${s.bytes} bytes, volumes ${[...s.volumes].join(',')}`);
    }
    return;
  }

  if (msg.type === 'proximity_update') {
    console.log(`[probe] proximity_update: ${JSON.stringify(msg.peers)}`);
  }
});

function startSending() {
  const started = Date.now();
  console.log(`[probe] sending ${opt.freq}Hz tone, ${FRAME_MS}ms frames.`);
  timer = setInterval(() => {
    const t = makeToneFrame(phase, opt.freq, opt.amplitude);
    phase = t.phase;
    ws.send(JSON.stringify({ type: 'audio_frame', seq: sent, data: t.buf.toString('base64') }));
    sent++;
    if (sent % 50 === 0) console.log(`[probe] -> ${sent} frames sent (${sent * FRAME_MS / 1000}s)`);
    if (opt.seconds > 0 && Date.now() - started >= opt.seconds * 1000) shutdown();
  }, FRAME_MS);
}

function shutdown() {
  if (timer) clearInterval(timer);
  console.log(`[probe] finished. sent=${sent}`);
  for (const [id, s] of received) {
    console.log(`[probe] received from 0x${id.toString(16)}: ${s.frames} frames, ${s.bytes} bytes`);
  }
  ws.close();
  setTimeout(() => process.exit(0), 100);
}

ws.on('error', (err) => { console.error('[probe] error:', err.message); process.exit(1); });
ws.on('close', () => { console.log('[probe] socket closed.'); if (timer) clearInterval(timer); });
process.on('SIGINT', shutdown);