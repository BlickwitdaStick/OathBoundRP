#!/usr/bin/env node
/**
 * Copies the already-built `voice-helper.exe` to `build-resources/`, from where
 * `electron-builder` packages it as `resources/vendor/voice-helper.exe`.
 *
 * The helper is C++/CMake/MSVC — it doesn't come out of `npm run build`. This
 * script is the bridge: if the exe exists, stage it; if not, **warn and exit 0**.
 * A contributor with no C++ toolchain can still build the launcher, and the
 * package ships without native voice (which is optional). Same philosophy as a
 * missing `CSC_LINK` for code signing.
 *
 * To include voice: build the helper first
 *   cd voice-helper && cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=.../vcpkg.cmake \
 *       -DVCPKG_TARGET_TRIPLET=x64-windows-static && cmake --build build --config Release
 * The static triplet matters: with the dynamic one the exe needs opus.dll/z.dll
 * next to it, and this script copies only the exe. See docs/technical/LAUNCHER_DISTRIBUTION.md §2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(launcherDir, '../../voice-helper/build/Release/voice-helper.exe');
const destDir = path.join(launcherDir, 'build-resources');
const dest = path.join(destDir, 'voice-helper.exe');

fs.mkdirSync(destDir, { recursive: true });

// Remove an old copy: a stale packaged exe is worse than none.
if (fs.existsSync(dest)) fs.rmSync(dest);

if (!fs.existsSync(source)) {
  console.warn(
    '[stage-voice-helper] voice-helper.exe not found at\n' +
    `  ${source}\n` +
    '  The launcher will be packaged WITHOUT native proximity voice.\n' +
    '  To include it: build voice-helper/ (cmake --build build --config Release) first.'
  );
  process.exit(0);
}

// Guard against packaging an exe that still depends on DLLs (dynamic build):
// in that case opus.dll/z.dll would sit next to the source and not be copied.
const sidecars = ['opus.dll', 'z.dll'].filter((dll) =>
  fs.existsSync(path.join(path.dirname(source), dll))
);
if (sidecars.length > 0) {
  console.error(
    `[stage-voice-helper] ERROR: ${sidecars.join(', ')} next to the exe — dynamic build.\n` +
    '  Rebuild with -DVCPKG_TARGET_TRIPLET=x64-windows-static (standalone exe).'
  );
  process.exit(1);
}

fs.copyFileSync(source, dest);
const kb = Math.round(fs.statSync(dest).size / 1024);
console.log(`[stage-voice-helper] voice-helper.exe stajado (${kb} KB) -> build-resources/`);
