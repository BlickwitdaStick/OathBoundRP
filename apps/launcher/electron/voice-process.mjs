import { spawn } from 'node:child_process';

/** Maximum time for Windows to confirm it created the helper process. */
export const VOICE_SPAWN_TIMEOUT_MS = 5_000;

/** @type {import('node:child_process').ChildProcess | null} */
let current = null;

/**
 * Starts `voice-helper.exe`. Only one at a time: a new `/voice` (new ticket)
 * kills the previous one. It is NOT `detached` — the helper is a child of the
 * launcher and dies with it, which is acceptable (voice stops; the player runs
 * `/voice` again). The launcher's `killGameProcesses` has
 * `taskkill voice-helper.exe` as a safety net.
 *
 * @param {string} exePath absolute path of voice-helper.exe
 * @param {string[]} args ['--actor-id', ..., '--ticket', ..., '--host', ..., '--port', ...]
 * @param {string} [cwd]
 * @param {{ spawnImpl?: typeof spawn, timeoutMs?: number }} [options]
 * @returns {Promise<{ pid: number }>}
 */
export async function startVoiceHelper(exePath, args, cwd, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? VOICE_SPAWN_TIMEOUT_MS;

  killVoiceHelper();

  let child;
  try {
    child = spawnImpl(exePath, args, {
      cwd,
      detached: false,
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
  } catch (cause) {
    throw new Error(`Could not start the voice-helper: ${errorMessage(cause)}`);
  }

  current = child;

  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      fn();
    };
    const onSpawn = () => finish(() => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        current = null;
        reject(new Error('voice-helper started without a valid PID.'));
        return;
      }
      resolve({ pid: child.pid });
    });
    const onError = (cause) => finish(() => {
      current = null;
      reject(new Error(`Could not start the voice-helper: ${errorMessage(cause)}`));
    });
    const timer = setTimeout(() => finish(() => {
      reject(new Error(`Windows did not confirm the voice-helper within ${timeoutMs} ms.`));
    }), timeoutMs);

    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('exit', () => { if (current === child) current = null; });
  });
}

/** Kills the current helper, if any. Idempotent. */
export function killVoiceHelper() {
  if (current) {
    try { current.kill(); } catch { /* already dead */ }
    current = null;
  }
}

export function voiceHelperRunning() {
  return current != null && current.exitCode == null && !current.killed;
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
