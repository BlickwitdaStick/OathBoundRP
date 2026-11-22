export const SKSE: {
  version: string;
  url: string;
  archiveSha256: string;
  archiveSize: number;
  folder: string;
  rootFiles: Record<string, string>;
};
export const SKYRIM_1170_SHA256: string;
export function sha256File(file: string): Promise<string>;
export function checkSkse(gamePath: string, opts?: { hash?: (file: string) => Promise<string> }): Promise<{
  installed: boolean;
  missing: string[];
  skyrimVersionOk: boolean | null;
}>;
export function downloadSkse(opts: {
  dest: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<string>;
export function installSkse(opts: {
  gamePath: string;
  sevenZipPath: string;
  workDir: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<{ installed: string[] }>;
