export const DEPOT_DOWNLOADER: { version: string; url: string; zipSha256: string; zipSize: number };
export const SKYRIM_1170: { app: number; depots: ReadonlyArray<readonly [number, string]> };
export function isValidSteamUsername(name: string): boolean;
export function downgradeArgs(opts: { gamePath: string; username: string }): string[];
export function ensureDepotDownloader(opts: {
  toolDir: string;
  sevenZipPath: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<string>;
export function backupGameFiles(gamePath: string): { dir: string; saved: string[] };
export function runDepotDownloader(opts: { exe: string; args: string[]; spawnImpl?: unknown }): Promise<number>;
