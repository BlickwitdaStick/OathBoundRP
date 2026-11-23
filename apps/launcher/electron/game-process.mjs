import { spawn } from 'node:child_process';

/** Maximum time for Windows to confirm it created the process. */
export const GAME_SPAWN_TIMEOUT_MS = 5_000;

/**
 * Operational error from the game bootstrap. `code` is stable so the UI can
 * translate the failure without depending on the message (which may include OS text).
 */
export class GameProcessError extends Error {
  /**
   * @param {'GAME_SPAWN_FAILED'|'GAME_SPAWN_TIMEOUT'|'GAME_SPAWN_NO_PID'} code
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GameProcessError';
    this.code = code;
  }
}

/**
 * Starts SKSE directly, without passing the path or arguments through a shell.
 * The Promise only resolves after Node receives the `spawn` confirmation, so
 * the caller doesn't announce success when the executable never even opened.
 *
 * @param {string} exePath absolute path of `skse64_loader.exe`
 * @param {string} cwd the Skyrim directory
 * @param {{spawnImpl?: typeof spawn, timeoutMs?: number}} [options]
 * @returns {Promise<{pid: number}>}
 */
export async function startGameProcess(exePath, cwd, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? GAME_SPAWN_TIMEOUT_MS;

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawnImpl(exePath, [], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
  } catch (cause) {
    throw new GameProcessError(
      'GAME_SPAWN_FAILED',
      `Could not start the game: ${errorMessage(cause)}`,
      { cause }
    );
  }

  return await new Promise((resolve, reject) => {
    let settled = false;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      callback();
    };

    const onSpawn = () => settle(() => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        reject(new GameProcessError(
          'GAME_SPAWN_NO_PID',
          'The game process started without providing a valid PID.'
        ));
        return;
      }

      // Only detach after the confirmation. Before that, we need to watch
      // `error` so a bootstrap failure doesn't turn into a false success.
      child.unref();
      resolve({ pid: child.pid });
    });

    const onError = (cause) => settle(() => reject(new GameProcessError(
      'GAME_SPAWN_FAILED',
      `Could not start the game: ${errorMessage(cause)}`,
      { cause }
    )));

    const timer = setTimeout(() => settle(() => reject(new GameProcessError(
      'GAME_SPAWN_TIMEOUT',
      `Windows did not confirm the game started within ${timeoutMs} ms.`
    ))), timeoutMs);

    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
