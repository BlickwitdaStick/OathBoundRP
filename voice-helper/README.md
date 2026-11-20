# voice-helper

A Windows executable that captures the microphone **outside the SkyMP client's embedded browser** and sends audio frames to the gamemode's `voip-service`, which relays them based on proximity.

It exists because the client's CEF does not allow `getUserMedia`, and the Chromium flag that enabled it was **deliberately removed** in SkyrimPlatform 2.1 — reverting that change would expose the player's microphone to any SkyMP server they connected to afterward. The architecture and reasoning are documented in [`docs/technical/VOICE_NATIVE_HELPER.md`](../docs/technical/VOICE_NATIVE_HELPER.md).

> ✅ **Successfully compiled and executed on 07/08/2026.** The first actual build succeeded (MSVC 19.44, CMake 4.4.2, vcpkg 2026-07-27), and the helper **captured real audio**: 50.1 frames/s against a nominal 50, exact framing, zero dropped frames. The measurements and the linker error encountered along the way are documented in VOICE_NATIVE_HELPER.md §8.3 and §8.4.
>
> ⚠️ **Nobody has listened to it yet.** It has been measured that the capture produces a signal; whether the voice comes through **intelligibly** has not been verified — that requires a person (§8.2). This is step 6 of stage 8.2 in `FASE_0_ROTEIRO.md`.

## Limitations of This Phase (Intentional)

- **The ticket is passed manually**, through the command line. There is no automatic handoff between the game and the helper — that is Phase 3 work. To read the ticket during a manual test, a temporary scaffold is available (`VOIP_DEBUG_EXPOSE_TICKET`), documented in VOICE_NATIVE_HELPER.md §11.
- ~~**The helper and the same player's UI cannot coexist.**~~ **Resolved on 07/08/2026.** The `auth` now carries a `role` (`listener` for the UI, `sender` for the helper), and `voip-service` stores both connections per actor. The helper sends `role: "sender"` automatically — nothing needs to be done on the command line. See VOICE_NATIVE_HELPER.md §10.
- **No UI, no system tray, no service.** It is a terminal process; exit with Ctrl+C.
- **Noise suppression: RNNoise, enabled by default.** It runs in the send loop, frame by frame, removing keyboard, fan, and background hiss before the relay. `--no-denoise` disables it (for A/B comparison). If RNNoise fails to initialize, the helper continues with raw audio instead of aborting.
- **No echo cancellation.** RNNoise only performs noise suppression, not AEC — anyone using speakers instead of headphones will still hear their own voice fed back into the scene.
- **Opus by default** (24 kbit/s VOIP, approximately 30 times less bandwidth than raw PCM). Each frame is marked `codec:"opus"`; the server does not decode it, it only forwards the label, and `index.html` decodes it through WebCodecs (`AudioDecoder`). `--pcm` switches back to raw s16le PCM — this is what the `frame-probe.js` test tool uses and is the mode for isolating faults. **Requires WebCodecs in the client runtime** (CEF 108 supports it; if the SkyrimPlatform build has it disabled, use `--pcm` until that is resolved).

## Building

Requirements: Windows, Visual Studio 2022 (the "Desktop development with C++" workload), CMake ≥ 3.21, and vcpkg.

**0. If the machine does not have the toolchain installed** (this was the case on the development machine as of 07/08/2026 — see VOICE_NATIVE_HELPER.md §8.1). Each command requires elevation; the first downloads approximately 5–8 GB and takes some time:

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
winget install --id Kitware.CMake
```

Then open a new terminal (the PATH changes only take effect in new terminals) and verify with `where cmake` and `where cl` before continuing. If `cl` does not appear, use the "Developer Command Prompt for VS 2022" instead of a regular terminal.

**1. vcpkg, if it is not already installed**

```bash
git clone https://github.com/microsoft/vcpkg C:/vcpkg
```

```bash
C:/vcpkg/bootstrap-vcpkg.bat
```

**2. Configure** (from `voice-helper/`). The `vcpkg.json` uses manifest mode: dependencies (`miniaudio`, `ixwebsocket`, `nlohmann-json`, `opus`) are downloaded and compiled during this step, without a separate `vcpkg install`.

```bash
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static
```

**Static triplet, by design:** `opus` and `zlib` are included in the executable, which is produced as a **standalone** binary — it only depends on Windows system DLLs. This is what the launcher packaging expects (one file, not an executable plus separate DLLs). The `CMakeLists.txt` automatically matches the static CRT (`/MT`) when the triplet ends in `-static`. With `x64-windows` (dynamic), the build also succeeds, but `opus.dll` and `z.dll` must be placed alongside the executable.

**3. Compile**

```bash
cmake --build build --config Release
```

The binary is generated at `build/Release/voice-helper.exe` (approximately 2.2 MB, standalone).

If any port fails to resolve, **record the exact error in VOICE_NATIVE_HELPER.md §8 before changing libraries** — the decision to use `miniaudio` is documented along with its reasoning, and silently replacing it would erase that reasoning as well.

**What actually happened during the first build (07/08/2026).** All three ports resolved using the names already present in `vcpkg.json`.

The failure this README anticipated — a duplicate `miniaudio` symbol if the port were precompiled — **did not happen**: the port is header-only (it installs only `miniaudio.h`), so `#define MINIAUDIO_IMPLEMENTATION` is correct, and the `find_path` in `CMakeLists.txt` is the right approach.

The actual error occurred during **linking**, and involved a different dependency:

```text
mbedcrypto.lib(entropy_poll.c.obj) : error LNK2019: unresolved external symbol, BCryptGenRandom
```

`ixwebsocket` pulls in `mbedtls`, which requires `bcrypt.lib` on Windows — even though we do not use TLS. This was fixed by adding `bcrypt` to `target_link_libraries`. Details are in VOICE_NATIVE_HELPER.md §8.3.

## Running

```bash
voice-helper.exe --actor-id 0xFF000A12 --ticket 753f03d8fa3c944a4c7b1dff7e7a08fb --host 127.0.0.1 --port 7778
```

| Argument | Required | Default | Description |
|---|---|---|---|
| `--actor-id` | Yes | — | Actor FormID, decimal or `0x` hexadecimal |
| `--ticket` | Yes | — | Single-use token issued by `/voz` |
| `--host` | No | `127.0.0.1` | `voip-service` host |
| `--port` | No | `7778` | `voip-service` port |

**The ticket is valid for 30 seconds and can only be used once.** Authentication failures are almost always caused by the ticket expiring between running `/voz` and executing the command — run `/voz` again and use the new ticket.

The server must have `ENABLE_VOIP_SERVICE=true`.

## Testing Without Building Anything

`tools/` contains the two tools used to validate Phase 1. Both use the gamemode's `ws` package; neither has its own `node_modules`.

**Harness** — starts the actual `voip-service` with fake positions and serves the real `index.html`:

```bash
node voice-helper/tools/e2e-harness.js --voip-port 7778 --http-port 8099
```

> ⚠️ The harness issues voice tickets to any `actorId` that requests one, **without authentication** — this is exactly the vulnerability that the ticket-based handshake addresses. Use it only on `127.0.0.1`, on a development machine.

Routes: `/` (the UI), `/ticket?actorId=&role=`, `/move?actorId=&x=&y=&z=`, `/state`.

The `role` parameter for `/ticket` is `listener` (default, what the page requests) or `sender` (what the probe and helper use). These are deliberately different tickets — one cannot be used in place of the other, and this is what allows both roles for the same player to remain connected simultaneously. See VOICE_NATIVE_HELPER.md §10.

**Probe** — uses the same protocol as the helper, but sends a 440 Hz tone instead of microphone audio. This isolates capture failures from transport failures:

```bash
node voice-helper/tools/frame-probe.js --actor-id 0xFF000A12 --ticket <sender token> --seconds 10
```

```bash
node voice-helper/tools/frame-probe.js --listen --actor-id 0xFF000A13 --ticket <listener token>
```

The role follows the mode: when generating a tone, it authenticates as `sender` (what the helper does); with `--listen`, it authenticates as `listener` (what the UI does). `--role` forces the opposite role, allowing the wrong side to be tested deliberately. Request a ticket for the correct role from the harness — `/ticket?actorId=0xFF000A12&role=sender` — otherwise authentication will be rejected.

The complete test procedure and measured results are in VOICE_NATIVE_HELPER.md §7.

## Wire Format

Mono, 48 kHz, 20 ms frames (960 samples). The contents of `data` (base64):

- **Opus** (default) — Opus VOIP packet, `codec:"opus"` in the JSON. Approximately 60 bytes per frame.
- **PCM** (`--pcm`) — raw s16le, 1,920 bytes per frame → 2,560 base64 characters, without `codec`.

The sample rate and frame size appear in three files, and all three must agree; if they differ, audio plays at the wrong speed instead of failing cleanly:

- `src/main.cpp` — `kSampleRate`, `kChannels`, `kFrameMs`
- `skymp/gamemode/voip-service.js` — `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`, `AUDIO_FRAME_MS`
- `skymp/ui/index.html` — `RELAY_SAMPLE_RATE`, `RELAY_FRAME_US`

The server never inspects the contents of `data` — it carries the `codec` label and forwards it.