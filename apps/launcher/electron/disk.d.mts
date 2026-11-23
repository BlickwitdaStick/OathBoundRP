/**
 * Types for `disk.mjs`. The module is plain JS so it runs under `node --test`
 * with no build step; this declaration keeps `main.ts` typechecked.
 */

export const RESERVE_BYTES: number;

export function formatBytes(n: number): string;

export function isDiskFull(err: unknown): boolean;

export function checkFreeSpace(
  targets: Array<{ label: string; freeBytes: number | null; neededBytes: number }> | null | undefined,
  reserve?: number
): { ok: boolean; error?: string; unmeasured?: string[] };
