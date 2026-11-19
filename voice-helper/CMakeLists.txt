cmake_minimum_required(VERSION 3.21)

# Project deliberately kept separate from the rest of the monorepo: the gamemode
# is plain JS loaded directly by SkyMP and has no build step. Tying a C++
# toolchain to `npm test` would make every contributor need MSVC to run
# JavaScript tests. This directory builds on its own.
project(voice-helper LANGUAGES CXX C)  # C: rnnoise (FetchContent) is plain C

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# DLL-free packaging: the default build is vcpkg's static triplet
# (`x64-windows-static`), so `opus` and `zlib` go into the exe and the launcher
# ships a single file. See docs/technical/LAUNCHER_DISTRIBUTION.md §2.
#
# The static triplet links the static CRT (/MT); our code and the `rnnoise`
# target have to match it, otherwise the link fails with LNK2038 (RuntimeLibrary
# mismatch) — vcpkg takes care of the dependencies, not of this file's targets.
if(VCPKG_TARGET_TRIPLET MATCHES "-static")
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

find_package(unofficial-miniaudio CONFIG QUIET)
if(NOT unofficial-miniaudio_FOUND)
  # The vcpkg miniaudio port has exported the target under different names over
  # time. Since it's header-only, finding the header is enough.
  find_path(MINIAUDIO_INCLUDE_DIR miniaudio.h REQUIRED)
endif()

find_package(ixwebsocket CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(Opus CONFIG REQUIRED)

# rnnoise: noise suppression.
#
# It does NOT come from vcpkg: the `rnnoise` port is declared `!windows` (it
# uses autotools and fails on MSVC — seen on the first build, 2026-08-07).
# Instead of forcing it with `--allow-unsupported`, we fetch the source straight
# from Xiph's v0.1.1 tag, the last one before the model became a separate
# download — the network weights live in `src/rnn_data.c`, in the repository
# itself. It's ~7 C files with no dependencies at all; we build them as a
# static lib here.
include(FetchContent)
FetchContent_Declare(rnnoise
  GIT_REPOSITORY https://github.com/xiph/rnnoise
  GIT_TAG v0.1.1
  GIT_SHALLOW TRUE
  PATCH_COMMAND ${CMAKE_COMMAND}
    -DRNNOISE_SRC_DIR=<SOURCE_DIR>
    -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/patch-rnnoise-msvc.cmake
)
FetchContent_MakeAvailable(rnnoise)

add_library(rnnoise STATIC
  ${rnnoise_SOURCE_DIR}/src/celt_lpc.c
  ${rnnoise_SOURCE_DIR}/src/denoise.c
  ${rnnoise_SOURCE_DIR}/src/kiss_fft.c
  ${rnnoise_SOURCE_DIR}/src/pitch.c
  ${rnnoise_SOURCE_DIR}/src/rnn.c
  ${rnnoise_SOURCE_DIR}/src/rnn_data.c
  ${rnnoise_SOURCE_DIR}/src/rnn_reader.c
)
target_include_directories(rnnoise PUBLIC ${rnnoise_SOURCE_DIR}/include)
target_include_directories(rnnoise PRIVATE ${rnnoise_SOURCE_DIR}/src)
if(MSVC)
  # kiss_fft.c and pitch.c use M_PI; MSVC only exposes it with this macro.
  target_compile_definitions(rnnoise PRIVATE _USE_MATH_DEFINES _CRT_SECURE_NO_WARNINGS)
  target_compile_options(rnnoise PRIVATE /w)  # third-party source, no /W4
endif()

add_executable(voice-helper src/main.cpp)

if(unofficial-miniaudio_FOUND)
  target_link_libraries(voice-helper PRIVATE unofficial::miniaudio::miniaudio)
else()
  target_include_directories(voice-helper PRIVATE ${MINIAUDIO_INCLUDE_DIR})
endif()

target_link_libraries(voice-helper PRIVATE
  ixwebsocket::ixwebsocket
  nlohmann_json::nlohmann_json
  Opus::opus
)

target_link_libraries(voice-helper PRIVATE rnnoise)

if(WIN32)
  # WASAPI comes from miniaudio's backend; these are the socket and device
  # enumeration libs that it and ixwebsocket need on Windows.
  #
  # bcrypt: ixwebsocket pulls in mbedtls (TLS), and mbedcrypto's entropy_poll
  # calls BCryptGenRandom, which lives in bcrypt.lib. Without it the link fails
  # with LNK2019 even though we don't use TLS anywhere — the object brings in
  # the whole lib, not just what we call. Found on the first real build,
  # 2026-08-07; see VOICE_NATIVE_HELPER.md §8.3.
  target_link_libraries(voice-helper PRIVATE ws2_32 ole32 winmm bcrypt)
  target_compile_definitions(voice-helper PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
  )
endif()

if(MSVC)
  target_compile_options(voice-helper PRIVATE /W4)
else()
  target_compile_options(voice-helper PRIVATE -Wall -Wextra)
endif()
