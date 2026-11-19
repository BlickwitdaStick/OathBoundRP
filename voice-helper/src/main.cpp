// voice-helper — captures the microphone outside CEF and sends the frames to
// the gamemode's voip-service.
//
// Why this process exists: the SkyMP client's embedded browser (CEF) does not
// allow `getUserMedia`. The Chromium flag that allowed it was *deliberately
// removed* in SkyrimPlatform 2.1, and reverting that would expose the player's
// microphone to any SkyMP server they connected to afterwards — the client
// opens whatever URL the server sends. See docs/technical/VOICE_NATIVE_HELPER.md.
//
// Capture leaves the browser; playback stays in it (playing received audio was
// never blocked). The server becomes a relay: it receives from here, decides by
// proximity who hears it and at what volume, and forwards it.
//
// Phase 1 (proof of concept). No UI, no automatic ticket handoff, no
// packaging. Command-line arguments and Ctrl+C to quit.

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include <nlohmann/json.hpp>

#include <rnnoise.h>

#include <opus.h>

namespace {

// Wire format — must match AUDIO_* in skymp/gamemode/voip-service.js and
// RELAY_SAMPLE_RATE in skymp/ui/index.html. Three places, one sample rate and
// one frame size; if any of them diverges, audio comes out at the wrong speed
// instead of failing cleanly.
//
// What goes INSIDE `data` is Opus by default (tagged `codec:"opus"` in the
// JSON) or raw s16le PCM with `--pcm`. The server doesn't look at the bytes;
// the listener picks the decoder from the tag. Opus at 48kHz mono, 20ms frames.
constexpr ma_uint32 kSampleRate = 48000;
constexpr ma_uint32 kChannels = 1;
constexpr ma_uint32 kFrameMs = 20;
constexpr ma_uint32 kSamplesPerFrame = kSampleRate / 1000 * kFrameMs;  // 960

// Opus. 24 kbit/s is where voice becomes transparent (libopus VOIP); in-band
// FEC + 10% declared loss give robustness to network jitter without requiring
// anything from the decoding side. Generous packet cap — a 20ms frame at 24k
// stays well under 200 bytes, but Opus can inflate on transients.
constexpr opus_int32 kOpusBitrate = 24000;
constexpr int kOpusMaxPacket = 1500;

// RNNoise processes frames of 480 samples (10ms @ 48kHz) — the fixed value
// `rnnoise_get_frame_size()` returns. Our wire frame (20ms) must be an exact
// multiple of it, otherwise a chunk of every frame would go without denoising.
constexpr ma_uint32 kDenoiseFrame = 480;
static_assert(kSamplesPerFrame % kDenoiseFrame == 0,
              "wire frame must be a multiple of the RNNoise frame");

// Cap of the queue between the audio thread and the network thread, in frames (~1s).
//
// This is not an optimization: the miniaudio callback runs on a real-time
// thread and must not block waiting on the network. If the socket stalls, the
// queue grows; on hitting the cap we drop the OLDEST frame. In a conversation,
// old audio has no value — delivering it late is worse than not delivering it.
constexpr size_t kMaxQueuedFrames = 50;

std::atomic<bool> g_running{true};

void OnSignal(int) { g_running = false; }

// ── base64 ────────────────────────────────────────────────────────────────
// Hand-written instead of pulling in another dependency: it's 20 lines and the
// only use of base64 in the whole program.
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string Base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kB64[(n >> 18) & 63]);
    out.push_back(kB64[(n >> 12) & 63]);
    out.push_back(kB64[(n >> 6) & 63]);
    out.push_back(kB64[n & 63]);
  }
  if (i < len) {
    uint32_t n = data[i] << 16;
    const bool two = (i + 1 < len);
    if (two) n |= data[i + 1] << 8;
    out.push_back(kB64[(n >> 18) & 63]);
    out.push_back(kB64[(n >> 12) & 63]);
    out.push_back(two ? kB64[(n >> 6) & 63] : '=');
    out.push_back('=');
  }
  return out;
}

// ── noise suppression (RNNoise) ──────────────────────────────────────────
// Runs in the send loop, not in the audio callback: it keeps the real-time
// callback doing the bare minimum, and RNNoise's cost (a few µs per 10ms frame)
// fits comfortably in the network loop's 20ms budget.
//
// State is kept between calls and frames must arrive in order. If the network
// stalls and the FrameQueue drops an old frame (§ kMaxQueuedFrames), RNNoise
// sees a discontinuity — a short click, not a failure. It's the same trade-off
// that already exists for raw audio.
//
// The samples RNNoise expects are floats on the SAME scale as int16
// (-32768..32767), not normalized to [-1,1].
class Denoiser {
 public:
  Denoiser() : state_(rnnoise_create(nullptr)) {}
  ~Denoiser() {
    if (state_ != nullptr) rnnoise_destroy(state_);
  }
  Denoiser(const Denoiser&) = delete;
  Denoiser& operator=(const Denoiser&) = delete;

  bool ok() const { return state_ != nullptr; }

  // Filters the frame in place. frame.size() must be a multiple of kDenoiseFrame.
  void Process(std::vector<int16_t>& frame) {
    if (state_ == nullptr) return;
    float buf[kDenoiseFrame];
    for (size_t off = 0; off + kDenoiseFrame <= frame.size(); off += kDenoiseFrame) {
      for (ma_uint32 i = 0; i < kDenoiseFrame; ++i) {
        buf[i] = static_cast<float>(frame[off + i]);
      }
      rnnoise_process_frame(state_, buf, buf);
      for (ma_uint32 i = 0; i < kDenoiseFrame; ++i) {
        float s = buf[i];
        if (s > 32767.0f) s = 32767.0f;
        else if (s < -32768.0f) s = -32768.0f;
        frame[off + i] = static_cast<int16_t>(s < 0.0f ? s - 0.5f : s + 0.5f);
      }
    }
  }

 private:
  DenoiseState* state_;
};

// ── codec (Opus) ─────────────────────────────────────────────────────────
// Runs in the send loop, alongside the denoiser: the audio callback keeps only
// accumulating. One encoder, fed in order, one 20ms frame at a time.
//
// `--pcm` skips this and sends raw s16le PCM — the historical wire format, the
// one the `frame-probe.js` probe speaks, and the way to isolate defects (same
// PCM-vs-codec logic as §3 of the doc: if the voice comes out broken, `--pcm`
// tells you whether the problem is Opus or the transport).
class OpusEncoderWrap {
 public:
  OpusEncoderWrap() {
    int err = OPUS_OK;
    enc_ = opus_encoder_create(static_cast<opus_int32>(kSampleRate),
                               static_cast<int>(kChannels),
                               OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || enc_ == nullptr) {
      enc_ = nullptr;
      return;
    }
    opus_encoder_ctl(enc_, OPUS_SET_BITRATE(kOpusBitrate));
    opus_encoder_ctl(enc_, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(enc_, OPUS_SET_PACKET_LOSS_PERC(10));
    opus_encoder_ctl(enc_, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
  }
  ~OpusEncoderWrap() {
    if (enc_ != nullptr) opus_encoder_destroy(enc_);
  }
  OpusEncoderWrap(const OpusEncoderWrap&) = delete;
  OpusEncoderWrap& operator=(const OpusEncoderWrap&) = delete;

  bool ok() const { return enc_ != nullptr; }

  // Returns the packet size in bytes, or -1 on error. `frame` must have
  // exactly kSamplesPerFrame samples.
  int Encode(const std::vector<int16_t>& frame, uint8_t* out, int max_out) {
    if (enc_ == nullptr) return -1;
    const int n = opus_encode(enc_, frame.data(),
                              static_cast<int>(kSamplesPerFrame), out, max_out);
    return n < 0 ? -1 : n;
  }

 private:
  OpusEncoder* enc_ = nullptr;
};

// ── queue between the audio thread and the network thread ─────────────────
class FrameQueue {
 public:
  void Push(std::vector<int16_t>&& frame) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (queue_.size() >= kMaxQueuedFrames) {
        queue_.pop_front();
        ++dropped_;
      }
      queue_.push_back(std::move(frame));
    }
    cv_.notify_one();
  }

  // Returns false when it's time to shut down.
  bool Pop(std::vector<int16_t>& out) {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait_for(lock, std::chrono::milliseconds(100),
                 [this] { return !queue_.empty() || !g_running; });
    if (queue_.empty()) return g_running.load();
    out = std::move(queue_.front());
    queue_.pop_front();
    return true;
  }

  void Wake() { cv_.notify_all(); }
  uint64_t dropped() const { return dropped_; }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::vector<int16_t>> queue_;
  std::atomic<uint64_t> dropped_{0};
};

// State shared with the audio callback. Held by pointer in
// ma_device_config::pUserData; nothing here allocates on the hot path other
// than the vector of the finished frame.
struct CaptureState {
  FrameQueue* queue = nullptr;
  std::vector<int16_t> accumulator;  // leftover between callbacks
};

// Called by miniaudio on a real-time thread. Rule: no network, no I/O, no
// long-held locks. It only accumulates and pushes to the queue.
void OnCapture(ma_device* device, void* /*output*/, const void* input,
               ma_uint32 frameCount) {
  auto* state = static_cast<CaptureState*>(device->pUserData);
  if (state == nullptr || input == nullptr) return;

  const int16_t* samples = static_cast<const int16_t*>(input);
  state->accumulator.insert(state->accumulator.end(), samples, samples + frameCount);

  // The WASAPI buffer size is not a multiple of 20ms, so there is almost always
  // a leftover chunk — it stays in the accumulator for the next callback.
  // Cutting off the remainder would produce periodic pops.
  while (state->accumulator.size() >= kSamplesPerFrame) {
    std::vector<int16_t> frame(state->accumulator.begin(),
                               state->accumulator.begin() + kSamplesPerFrame);
    state->accumulator.erase(state->accumulator.begin(),
                             state->accumulator.begin() + kSamplesPerFrame);
    state->queue->Push(std::move(frame));
  }
}

struct Options {
  uint32_t actor_id = 0;
  std::string ticket;
  std::string host = "127.0.0.1";
  uint16_t port = 7778;
  bool denoise = true;
  bool pcm = false;  // send raw PCM instead of Opus
  bool valid = false;
};

void PrintUsage(const char* argv0) {
  std::fprintf(stderr,
    "voice-helper — captures the microphone and sends it to the SkyMP voip-service\n"
    "\n"
    "Usage:\n"
    "  %s --actor-id <id> --ticket <token> [--host <host>] [--port <port>]\n"
    "\n"
    "  --actor-id   actor formID, decimal or 0x-hex (e.g. 0xFF000A12)\n"
    "  --ticket     single-use token issued by the server (/voice command)\n"
    "  --host       voip-service host (default: 127.0.0.1)\n"
    "  --port       voip-service port (default: 7778)\n"
    "  --no-denoise turns off noise suppression (RNNoise); on by default\n"
    "  --pcm        sends raw s16le PCM instead of Opus (for debugging/probe)\n"
    "\n"
    "The ticket is valid for 30 seconds and can only be used once. In Phase 1 it\n"
    "is passed by hand — there is no automatic handoff between the game and the helper.\n"
    "See voice-helper/README.md.\n",
    argv0);
}

Options ParseArgs(int argc, char** argv) {
  Options opt;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const bool has_next = (i + 1 < argc);
    if (arg == "--actor-id" && has_next) {
      // stoul base 0: accepts 0xFF000A12 and decimal. FormIDs go beyond 2^31,
      // so the type must be unsigned — with int, 0xFF000A12 overflows.
      try {
        opt.actor_id = static_cast<uint32_t>(std::stoul(argv[++i], nullptr, 0));
      } catch (const std::exception&) {
        std::fprintf(stderr, "[helper] invalid --actor-id: %s\n", argv[i]);
        return opt;
      }
    } else if (arg == "--ticket" && has_next) {
      opt.ticket = argv[++i];
    } else if (arg == "--host" && has_next) {
      opt.host = argv[++i];
    } else if (arg == "--port" && has_next) {
      opt.port = static_cast<uint16_t>(std::stoul(argv[++i]));
    } else if (arg == "--no-denoise") {
      opt.denoise = false;
    } else if (arg == "--pcm") {
      opt.pcm = true;
    } else if (arg == "--help" || arg == "-h") {
      return opt;
    } else {
      std::fprintf(stderr, "[helper] unknown argument: %s\n", arg.c_str());
      return opt;
    }
  }
  opt.valid = (opt.actor_id != 0 && !opt.ticket.empty());
  return opt;
}

}  // namespace

int main(int argc, char** argv) {
  const Options opt = ParseArgs(argc, argv);
  if (!opt.valid) {
    PrintUsage(argv[0]);
    return 2;
  }

  std::signal(SIGINT, OnSignal);
  std::signal(SIGTERM, OnSignal);

  ix::initNetSystem();

  // ── noise suppression ──────────────────────────────────────────────────
  // Created before the microphone: if RNNoise fails to initialize, the helper
  // keeps sending raw audio instead of aborting — losing the denoiser is a
  // degradation, not a failure. `--no-denoise` skips it on purpose (useful for
  // A/B comparison and for isolating defects, in line with what §3 of the doc
  // already does with PCM vs Opus).
  Denoiser denoiser;
  bool denoise = opt.denoise && denoiser.ok();
  if (opt.denoise && !denoiser.ok()) {
    std::fprintf(stderr,
      "[helper] RNNoise failed to initialize; continuing with raw audio.\n");
  }
  std::printf("[helper] Noise suppression: %s\n", denoise ? "on" : "off");

  // ── codec ──────────────────────────────────────────────────────────────
  // Same policy as the denoiser: if the Opus encoder can't be created, fall
  // back to raw PCM instead of aborting. `--pcm` forces PCM on purpose.
  OpusEncoderWrap encoder;
  bool use_opus = !opt.pcm && encoder.ok();
  if (!opt.pcm && !encoder.ok()) {
    std::fprintf(stderr,
      "[helper] Opus encoder failed to initialize; sending raw PCM.\n");
  }
  std::printf("[helper] Codec: %s\n", use_opus ? "opus" : "pcm");

  FrameQueue queue;
  CaptureState capture_state;
  capture_state.queue = &queue;
  capture_state.accumulator.reserve(kSamplesPerFrame * 4);

  // ── microphone (WASAPI in shared mode) ─────────────────────────────────
  // Shared, not exclusive: in exclusive mode the helper would take the device
  // away from the rest of the system, and the player would lose audio from
  // Discord, the browser and anything else while playing.
  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = ma_format_s16;
  config.capture.channels = kChannels;
  config.capture.shareMode = ma_share_mode_shared;
  config.sampleRate = kSampleRate;
  config.dataCallback = OnCapture;
  config.pUserData = &capture_state;

  ma_device device;
  if (ma_device_init(nullptr, &config, &device) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Failed to open the default microphone.\n");
    ix::uninitNetSystem();
    return 1;
  }

  // What miniaudio actually managed to negotiate may not be what we asked for.
  // The server and the UI assume a fixed 48kHz mono, so a mismatch here would
  // become wrong-speed audio on the other end — failing loudly is better.
  if (device.capture.internalSampleRate != kSampleRate) {
    std::fprintf(stderr,
      "[helper] Warning: device at %u Hz; miniaudio is resampling to %u Hz.\n",
      device.capture.internalSampleRate, kSampleRate);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────
  // Same port and same ticket handshake that index.html already uses. Inventing
  // a second authentication system for the same thing would double the attack
  // surface in exchange for nothing.
  const std::string url = "ws://" + opt.host + ":" + std::to_string(opt.port);
  ix::WebSocket ws;
  ws.setUrl(url);
  ws.disableAutomaticReconnection();  // the ticket is single-use: reconnecting on its own would fail

  std::atomic<bool> authed{false};
  std::atomic<bool> auth_failed{false};

  ws.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Open) {
      std::printf("[helper] Connected to %s; authenticating as sender.\n", url.c_str());
      // `role: "sender"` is what lets this process coexist with the SAME
      // player's index.html. Without the field the server assumes "listener"
      // (the compatibility default), and the two connections would fight over
      // the same slot — whoever authenticated last would knock the other out.
      // The ticket is per role too: `/voice` issues one for the UI and one for
      // the helper. See docs/technical/VOICE_NATIVE_HELPER.md §10.
      nlohmann::json auth{{"type", "auth"},
                          {"actorId", opt.actor_id},
                          {"ticket", opt.ticket},
                          {"role", "sender"}};
      ws.send(auth.dump());
    } else if (msg->type == ix::WebSocketMessageType::Message) {
      nlohmann::json parsed = nlohmann::json::parse(msg->str, nullptr, false);
      if (parsed.is_discarded() || !parsed.contains("type")) return;
      const std::string type = parsed["type"].get<std::string>();
      if (type == "auth_ok") {
        authed = true;
        std::printf("[helper] Authenticated. Capturing; Ctrl+C to quit.\n");
      } else if (type == "auth_failed") {
        auth_failed = true;
        std::fprintf(stderr,
          "[helper] Auth rejected. The ticket is valid for 30s and works only once — "
          "run /voice again and use the new token.\n");
        g_running = false;
        queue.Wake();
      }
      // proximity_update / audio_frame arrive here too and are ignored on
      // purpose: the game's browser plays audio, not this process.
    } else if (msg->type == ix::WebSocketMessageType::Error) {
      std::fprintf(stderr, "[helper] Socket error: %s\n",
                   msg->errorInfo.reason.c_str());
      g_running = false;
      queue.Wake();
    } else if (msg->type == ix::WebSocketMessageType::Close) {
      std::fprintf(stderr, "[helper] Connection closed by the server.\n");
      g_running = false;
      queue.Wake();
    }
  });

  ws.start();

  if (ma_device_start(&device) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Failed to start capture.\n");
    ma_device_uninit(&device);
    ws.stop();
    ix::uninitNetSystem();
    return 1;
  }

  // ── send loop ───────────────────────────────────────────────────────────
  uint64_t seq = 0;
  uint64_t sent = 0;
  std::vector<int16_t> frame;

  while (g_running) {
    if (!queue.Pop(frame) || frame.empty()) continue;

    // Frames captured before auth_ok are discarded: the server would ignore
    // them anyway, and keeping them would only add delay to the first syllable
    // anyone actually hears.
    if (!authed) { frame.clear(); continue; }

    if (denoise) denoiser.Process(frame);

    std::string data;
    if (use_opus) {
      uint8_t packet[kOpusMaxPacket];
      const int n = encoder.Encode(frame, packet, kOpusMaxPacket);
      if (n < 0) {
        // An encode error is rare and not recoverable frame by frame; it counts
        // as a lost frame, same as a queue drop.
        frame.clear();
        continue;
      }
      data = Base64Encode(packet, static_cast<size_t>(n));
    } else {
      data = Base64Encode(reinterpret_cast<const uint8_t*>(frame.data()),
                          frame.size() * sizeof(int16_t));
    }

    nlohmann::json out{{"type", "audio_frame"}, {"seq", seq++}, {"data", data}};
    if (use_opus) out["codec"] = "opus";
    ws.send(out.dump());
    frame.clear();

    if (++sent % 250 == 0) {  // ~5s
      std::printf("[helper] %llu frames sent (%llu dropped in the queue).\n",
                  static_cast<unsigned long long>(sent),
                  static_cast<unsigned long long>(queue.dropped()));
      std::fflush(stdout);
    }
  }

  std::printf("[helper] Shutting down. %llu frames sent.\n",
              static_cast<unsigned long long>(sent));

  ma_device_uninit(&device);
  ws.stop();
  ix::uninitNetSystem();
  return auth_failed ? 1 : 0;
}
