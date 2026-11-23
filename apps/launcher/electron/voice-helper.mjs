import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Installs/repairs `voice-helper.exe` (microphone capture outside CEF, for
 * proximity voice — see docs/technical/VOICE_NATIVE_HELPER.md) in the game
 * folder, from the copy that travels inside the launcher.
 *
 * Unlike the UI (`ui-integrity.mjs`), this is **fail-open**: voice is optional
 * and a missing binary must not block PLAY. The helper is built by CMake/MSVC,
 * not by `npm run build` — on a contributor machine with no C++ toolchain,
 * `scripts/stage-voice-helper.mjs` stages nothing and the package ships without it.
 *
 * @param {{ sourcePath: string, targetPath: string }} opts
 * @returns {{ ok: boolean, repaired: boolean, skipped?: boolean, reason?: string, error?: string }}
 */
export function syncVoiceHelper({ sourcePath, targetPath }) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      // Not an error: it only means this package was built without the helper.
      return { ok: true, repaired: false, skipped: true, reason: 'binary not packaged' };
    }

    const targetValid = fs.existsSync(targetPath)
      && fs.statSync(targetPath).isFile()
      && sha256(targetPath) === sha256(sourcePath);

    if (targetValid) return { ok: true, repaired: false };

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    return { ok: true, repaired: true };
  } catch (error) {
    // Still fail-open for the caller, but returns the cause for the log.
    return { ok: false, repaired: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
