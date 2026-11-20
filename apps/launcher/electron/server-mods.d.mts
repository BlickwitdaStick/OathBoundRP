export class ServerModsError extends Error {
  readonly code: 'INVALID_MANIFEST' | 'PROTECTED_PATH' | 'DOWNLOAD_FAILED' | 'VERIFY_FAILED';
  constructor(code: string, message: string, cause?: unknown);
}

export interface ServerModFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ServerModsManifest {
  formatVersion: 1;
  version: string;
  files: ServerModFile[];
  plugins: string[];
  /** Base-game plugins (Creation Club) required but never downloaded. */
  basePlugins?: Array<{ name: string; size: number; sha256: string }>;
  totalBytes: number;
}

export interface HashCache {
  hash(fullPath: string): Promise<string>;
  save(): void;
}

export function isSafeRelativePath(rel: string): boolean;
export function validateManifest(manifest: unknown): ServerModsManifest;
export function createHashCache(cacheFile: string | null): HashCache;
export function planServerModSync(input: {
  manifest: ServerModsManifest;
  gamePath: string;
  hashCache?: HashCache;
}): Promise<{ toDownload: ServerModFile[]; totalBytes: number; upToDate: number; missingBase: string[] }>;
export function installServerMods(input: {
  gamePath: string;
  baseUrl: string;
  toDownload: ServerModFile[];
  fetchImpl?: typeof fetch;
  onProgress?: (p: { file: string; index: number; count: number; bytesDone: number; bytesTotal: number }) => void;
  /** Test seam for retry waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per file on 429/503/network errors (default 5). */
  maxAttempts?: number;
}): Promise<{ installed: string[] }>;
export function enableServerPlugins(input: { gamePath: string; plugins: string[] }): { changed: boolean };
