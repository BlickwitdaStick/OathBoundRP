import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process';

export const GAME_SPAWN_TIMEOUT_MS: number;

export type GameProcessErrorCode =
  | 'GAME_SPAWN_FAILED'
  | 'GAME_SPAWN_TIMEOUT'
  | 'GAME_SPAWN_NO_PID';

export class GameProcessError extends Error {
  readonly code: GameProcessErrorCode;
  constructor(code: GameProcessErrorCode, message: string, options?: ErrorOptions);
}

export interface GameProcessOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

export function startGameProcess(
  exePath: string,
  cwd: string,
  options?: GameProcessOptions
): Promise<{ pid: number }>;

// Keeps the imports above checked by the compiler and documents the types
// used by the JS implementation without exposing a second API.
export type _SpawnContract = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
