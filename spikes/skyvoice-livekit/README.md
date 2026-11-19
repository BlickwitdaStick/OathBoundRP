# SPIKE — SkyVoice over LiveKit

> **This is a spike, not production.** It exists to answer a question that
> needed an answer before choosing between Plan A (capture in CEF) and Plan B
> (capture in the native `voice-helper`): **does the LiveKit transport work
> with a token issued by our server, and does the audio get through?**
>
> The answer is yes, measured against a real `livekit-server`. See
> [`docs/technical/SKYVOICE_LIVEKIT_AUDIT.md`](../../docs/technical/SKYVOICE_LIVEKIT_AUDIT.md) §10–§11.

## What it proves

Two participants against a real `livekit-server`, with tokens signed by the
same module the gamemode uses (`skymp/gamemode/core/voice/livekit-token.js`):

- the token is accepted by the official server, and a token with the wrong
  secret is **rejected** (401);
- no API secret inside the token the client receives;
- audio published by A reaches B **through the SFU**, with the signal preserved;
- PTT (stop/resume capture) and hard mute (`unpublish`);
- camera refused by the server — **with a control**, see below;
- reconnection with a new token, and the `actorId` surviving the identity change;
- an unreachable server fails in a catchable way, without killing the process.

## What it does NOT prove

It's printed in the program's own output, so nobody reads only the scoreboard:

- **voice intelligible to the human ear** — that's not a measurement, it's a
  judgment. Same limitation recorded in `VOICE_NATIVE_HELPER.md` §8.2, and
  switching transports doesn't solve it;
- two real **Skyrim** clients;
- capture through CEF or the `voice-helper` (the participants are Node processes);
- **an unauthorized origin without a microphone** — that belongs to
  `CefPermissionHandler`, on the client side, and doesn't exist in this spike;
- a real network: latency, loss and jitter beyond `127.0.0.1`.

## The camera control

Worth highlighting because it almost became a wrong conclusion. When publishing
video with a token restricted to `canPublishSources: ['microphone']`, LiveKit
**does not return a permission error** — it ignores the publication and the
client times out (~10s).

A timeout on its own doesn't prove permission: it could be a `VideoSource` with
no frames. That's why the spike publishes video **twice** — once with the
restricted token, once with a control token without the restriction. The
restricted one times out in ~10s; the control publishes in tens of
milliseconds. It's the difference between the two that proves the permission,
and it runs every time, not just once.

## How to run

You need a `livekit-server`. Download the official binary and **verify the
checksum** (`checksums.txt` ships with every release in `livekit/livekit`).

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
  skyvoice_spike: <any secret for the test bench>
```

```bash
livekit-server --config livekit-spike.yaml
```

In another terminal:

```bash
npm install
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=skyvoice_spike LIVEKIT_API_SECRET=<the same one> npm run spike
```

It exits `0` if every check passes.

## Why it doesn't live in `voice-helper/tools/`

That directory is the test bench for the **legacy path** (`e2e-harness.js`,
`frame-probe.js`) and is still valid — the `voice-helper` won't be deleted.
This spike tests a different transport, has its own dependency
(`@livekit/rtc-node`) and is disposable by nature. Mixing it in there would make
it look like the helper depends on LiveKit, which isn't true today.
