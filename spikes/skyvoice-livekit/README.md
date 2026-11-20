# SPIKE — SkyVoice over LiveKit

> **This is a spike, not production code.** It exists to answer a question that needed to be resolved before choosing between Plan A (capture in CEF) and Plan B (capture in the native `voice-helper`): **does the LiveKit transport work with a token issued by our server, and does the audio make it through?**
>
> The answer is yes, measured against a real `livekit-server`. See [`docs/technical/SKYVOICE_LIVEKIT_AUDIT.md`](../../docs/technical/SKYVOICE_LIVEKIT_AUDIT.md) §10–§11.

## What it proves

Two participants connected to a real `livekit-server`, using tokens signed by the same module the gamemode uses (`skymp/gamemode/core/voice/livekit-token.js`):

- token accepted by the official server, and a token signed with the wrong secret **rejected** (401);
- no API secret inside the token received by the client;
- audio published by A reaches B **through the SFU**, with the signal preserved;
- PTT (stop/resume capture) and hard mute (`unpublish`);
- camera publication rejected by the server — **with a control test**, see below;
- reconnection with a new token, with the `actorId` surviving the identity change;
- an unreachable server fails in a catchable way, without crashing the process.

## What it does NOT prove

This is printed in the program's own output so nobody reads only the score:

- **voice intelligibility to the human ear** — this is not a measurement; it is a judgment. The same limitation is documented in `VOICE_NATIVE_HELPER.md` §8.2, and changing transports does not resolve it;
- two real **Skyrim** clients;
- capture through CEF or `voice-helper` (the participants are Node processes);
- **unauthorized origin without microphone access** — this is handled by `CefPermissionHandler` on the client side, and is not part of this spike;
- real-world network conditions: latency, packet loss, and jitter beyond `127.0.0.1`.

## The camera control test

This deserves special attention because it almost led to the wrong conclusion. When publishing video with a token restricted to `canPublishSources: ['microphone']`, LiveKit **does not return a permission error** — it ignores the publication and the client eventually times out (~10s).

A timeout alone does not prove permission enforcement: the `VideoSource` might simply not be producing frames. That is why the spike publishes video **twice** — once with the restricted token, and once with a control token that does not have the restriction. The restricted attempt times out in ~10s; the control token publishes in tens of milliseconds. The difference between the two proves that the permission is being enforced, and this test runs every time, not just once.

## How to run

Requires a `livekit-server`. Download the official binary and **verify its checksum** (`checksums.txt` accompanies each release in `livekit/livekit`).

`livekit-spike.yaml`:

```yaml
port: 7880
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50060
  use_external_ip: false
keys:
  skyvoice_spike: <any secret for the test environment>
```

```bash
livekit-server --config livekit-spike.yaml
```

In another terminal:

```bash
npm install
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=skyvoice_spike
LIVEKIT_API_SECRET=<the same secret>
npm run spike
```

Exits with code `0` if all checks pass.

## Why it does not live in `voice-helper/tools/`

That directory is the test bench for the **legacy path** (`e2e-harness.js`, `frame-probe.js`) and remains valid — `voice-helper` is not going to be deleted. This spike tests a different transport, has its own dependency (`@livekit/rtc-node`), and is disposable by nature. Mixing it in there would make it look as though the helper depends on LiveKit, which is not currently true.