# voice-helper

A Windows executable that captures the microphone **outside the SkyMP client's
embedded browser** and sends the frames to the gamemode's `voip-service`, which
relays them by proximity.

It exists because the client's CEF does not allow `getUserMedia`, and the
Chromium flag that allowed it was **deliberately removed** in SkyrimPlatform 2.1
— reverting that would expose the player's microphone to any SkyMP server they
connected to afterwards. The architecture and the reasoning are in
[`docs/technical/VOICE_NATIVE_HELPER.md`](../docs/technical/VOICE_NATIVE_HELPER.md).

> ✅ **Built and run on 2026-08-07.** The first real build passed (MSVC 19.44,
> CMake 4.4.2, vcpkg 2026-07-27) and the helper **captured real audio**: 50.1
> frames/s against 50 nominal, exact framing, zero drops. Numbers and the link
> error that came up along the way: VOICE_NATIVE_HELPER.md §8.3 and §8.4.
>
> ⚠️ **Nobody has listened yet.** That capture delivers a signal is measured;
> that the voice comes out **intelligible** is not — that needs a person (§8.2).
> It's step 6 of stage 8.2 in `FASE_0_ROTEIRO.md`.

## Limitations of this phase (deliberate)

- **The ticket is passed by hand**, on the command line. There is no automatic
  handoff between the game and the helper — that's Phase 3 work. To be able to
  read the ticket during a manual test there is temporary scaffolding
  (`VOIP_DEBUG_EXPOSE_TICKET`), described in VOICE_NATIVE_HELPER.md §11.
- ~~**The helper and the UI of the same player can't coexist.**~~ **Fixed on
  2026-08-07.** `auth` now carries `role` (`listener` for the UI, `sender` for
  the helper) and the `voip-service` keeps both connections per actor. The
  helper sends `role: "sender"` on its own — there's nothing to do on the
  command line. See VOICE_NATIVE_HELPER.md §10.
- **No UI, no tray icon, no service.** It's a terminal process; quit with Ctrl+C.
- **Noise suppression: RNNoise, on by default.** It runs in the send loop, frame
  by frame, and removes keyboard/fan/ambient hiss before the relay.
  `--no-denoise` turns it off (for A/B comparison). If RNNoise fails to
  initialize, the helper continues with raw audio instead of aborting.
- **No echo cancellation.** RNNoise only does noise suppression, not AEC —
  someone using speakers instead of headphones still feeds their own voice back
  into the scene.
- **Opus by default** (24 kbit/s VOIP, ~30x less bandwidth than raw PCM). The
  frame is tagged `codec:"opus"`; the server doesn't decode, it just passes the
  tag along, and `index.html` decodes via WebCodecs (`AudioDecoder`). `--pcm`
  goes back to raw s16le PCM — it's what the `frame-probe.js` probe speaks and
  the way to isolate defects. **Requires WebCodecs in the client runtime** (CEF
  108 has it; if the SkyrimPlatform build has it disabled, use `--pcm` until
  that's resolved).

## Building

Requirements: Windows, Visual Studio 2022 ("Desktop development with C++"
workload), CMake ≥ 3.21 and vcpkg.

**0. If the machine doesn't have the toolchain** (the case for the development
machine until 2026-08-07 — see VOICE_NATIVE_HELPER.md §8.1). Each command asks
for elevation; the first one downloads ~5–8 GB and takes a while:

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
winget install --id Kitware.CMake
```

Then open a new terminal (PATH only applies from there on) and confirm with
`where cmake` and `where cl` before continuing. If `cl` doesn't show up, use the
"Developer Command Prompt for VS 2022" instead of a regular terminal.

**1. vcpkg, if not already present**

```bash
git clone https://github.com/microsoft/vcpkg C:/vcpkg
```

```bash
C:/vcpkg/bootstrap-vcpkg.bat
```

**2. Configure** (from `voice-helper/`). `vcpkg.json` is in manifest mode: the
dependencies (`miniaudio`, `ixwebsocket`, `nlohmann-json`, `opus`) are
downloaded and built in this step, with no separate `vcpkg install`.

```bash
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static
```

**Static triplet on purpose:** `opus` and `zlib` go into the exe, which comes
out **standalone** — it only depends on Windows system DLLs. That's what
packaging through the launcher expects (one file, not an exe + loose DLLs).
`CMakeLists.txt` matches the static CRT (`/MT`) on its own when the triplet ends
in `-static`. With `x64-windows` (dynamic) the build also passes, but then
`opus.dll` and `z.dll` must sit next to the exe.

**3. Build**

```bash
cmake --build build --config Release
```

The binary ends up in `build/Release/voice-helper.exe` (~2.2 MB, standalone).

If some port doesn't resolve, **write down the exact error in
VOICE_NATIVE_HELPER.md §8 before switching libraries** — the decision to use
`miniaudio` is recorded with its reasoning, and swapping it silently would erase
the reasoning along with it.

**What actually happened on the first build (2026-08-07).** All three ports
resolved with the names already in `vcpkg.json`.

The failure this README anticipated — a duplicate `miniaudio` symbol if the
port came precompiled — **did not happen**: the port is header-only (it installs
only `miniaudio.h`), so `#define MINIAUDIO_IMPLEMENTATION` is right and the
`find_path` in `CMakeLists.txt` is the correct path.

The real error was at **link** time, and from another dependency:

```
mbedcrypto.lib(entropy_poll.c.obj) : error LNK2019: unresolved external
symbol BCryptGenRandom
```

`ixwebsocket` pulls in `mbedtls`, which needs `bcrypt.lib` on Windows — even
though we don't use TLS. Fixed by adding `bcrypt` to `target_link_libraries`.
Details in VOICE_NATIVE_HELPER.md §8.3.

## Running

```bash
voice-helper.exe --actor-id 0xFF000A12 --ticket 753f03d8fa3c944a4c7b1dff7e7a08fb --host 127.0.0.1 --port 7778
```

| Argument | Required | Default | What |
|---|---|---|---|
| `--actor-id` | yes | — | actor formID, decimal or `0x`-hex |
| `--ticket` | yes | — | single-use token issued by `/voice` |
| `--host` | no | `127.0.0.1` | `voip-service` host |
| `--port` | no | `7778` | `voip-service` port |

**The ticket is valid for 30 seconds and works only once.** A rejected auth is
almost always a ticket that expired between `/voice` and the command — run
`/voice` again and use the new one.

The server needs `ENABLE_VOIP_SERVICE=true`.

## Testing without building anything

`tools/` has the two tools that validated Phase 1. Both use the gamemode's
`ws`; neither has its own `node_modules`.

**Harness** — starts the real `voip-service` with fake positions and serves the
real `index.html`:

```bash
node voice-helper/tools/e2e-harness.js --voip-port 7778 --http-port 8099
```

> ⚠️ The harness issues a voice ticket for any `actorId` that asks, **with no
> authentication** — exactly the hole the ticket handshake closes. Only on
> `127.0.0.1`, on a development machine.

Routes: `/` (the UI), `/ticket?actorId=&role=`, `/move?actorId=&x=&y=&z=`, `/state`.

The `/ticket` `role` is `listener` (default, what the page fetches) or `sender`
(what the probe and the helper use). They are different tickets on purpose —
neither works in place of the other, and that's what lets both roles of the
same player be connected at the same time. See VOICE_NATIVE_HELPER.md §10.

**Probe** — speaks the same protocol as the helper, with a 440Hz tone instead of
the microphone. It's what separates a capture failure from a transport failure:

```bash
node voice-helper/tools/frame-probe.js --actor-id 0xFF000A12 --ticket <sender token> --seconds 10
```

```bash
node voice-helper/tools/frame-probe.js --listen --actor-id 0xFF000A13 --ticket <listener token>
```

The role follows the mode: generating a tone it authenticates as `sender` (what
the helper does), with `--listen` as `listener` (what the UI does). `--role`
forces the opposite, to test the wrong side on purpose. Ask the harness for the
ticket of the right role — `/ticket?actorId=0xFF000A12&role=sender` — or auth is
rejected.

Full test script and measured numbers: VOICE_NATIVE_HELPER.md §7.

## Wire format

Mono, 48kHz, 20ms frames (960 samples). What goes inside `data` (base64):

- **Opus** (default) — an Opus VOIP packet, `codec:"opus"` in the JSON. ~60 bytes/frame.
- **PCM** (`--pcm`) — raw s16le, 1920 bytes/frame → 2560 base64 chars, no `codec`.

The rate and frame size appear in three files and all three must agree;
diverging makes the audio come out at the wrong speed instead of failing cleanly:

- `src/main.cpp` — `kSampleRate`, `kChannels`, `kFrameMs`
- `skymp/gamemode/voip-service.js` — `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`, `AUDIO_FRAME_MS`
- `skymp/ui/index.html` — `RELAY_SAMPLE_RATE`, `RELAY_FRAME_US`

The server never looks inside `data` — it carries the `codec` tag and passes it on.
