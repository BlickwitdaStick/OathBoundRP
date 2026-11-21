import type { ServerModFile, ServerModsManifest } from './server-mods.mjs';

export const NEXUS_API: string;
export const NEXUS_API_KEY_PAGE: string;

export class NexusError extends Error {
  readonly code: 'NETWORK' | 'BAD_KEY' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'HTTP' | 'NO_LINK' |
    'DOWNLOAD_FAILED' | 'VERIFY_FAILED' | 'EXTRACT_FAILED';
  constructor(code: string, message: string, cause?: unknown);
}

export interface NexusProvide {
  /** Path inside the archive (as the recipe saw it). */
  src: string;
  /** Data path, as in the server manifest. */
  path: string;
  size: number;
  sha256: string;
}

export interface NexusSource {
  id: string;
  name: string;
  game: string;
  modId: number;
  fileId: number;
  version: string;
  fileName: string;
  /** 0 = Nexus does not report it. */
  size: number;
  provides: NexusProvide[];
}

export interface NxmLink {
  game: string;
  modId: number;
  fileId: number;
  key: string | null;
  expires: string | null;
}

export function nexusSourcesOf(manifest: ServerModsManifest & { nexus?: unknown }): NexusSource[];
export function planNexusDownloads(input: {
  sources: NexusSource[];
  toDownload: ServerModFile[];
  minShare?: number;
  smallArchiveBytes?: number;
}): {
  archives: Array<{ source: NexusSource; provides: NexusProvide[]; bytes: number }>;
  remaining: ServerModFile[];
  nexusBytes: number;
  serverBytes: number;
};
export function parseNxmUrl(raw: string): NxmLink | null;
export function nexusFilePageUrl(source: Pick<NexusSource, 'game' | 'modId' | 'fileId'>): string;
export function createNexusApi(input: {
  apiKey: string;
  appName: string;
  appVersion: string;
  fetchImpl?: typeof fetch;
}): {
  validate(): Promise<{ name: string; isPremium: boolean }>;
  downloadLink(source: Pick<NexusSource, 'game' | 'modId' | 'fileId'>, nxm?: NxmLink | null): Promise<string>;
};
export function downloadArchive(input: {
  url: string;
  dest: string;
  expectedSize: number;
  fetchImpl?: typeof fetch;
  onProgress?: (bytesDone: number, bytesTotal: number) => void;
}): Promise<{ reused: boolean }>;
export function parse7zList(stdout: string): Array<{ path: string; size: number }>;
export function matchArchiveEntries(
  entries: Array<{ path: string; size: number }>,
  provides: NexusProvide[]
): Array<{ provide: NexusProvide; entry: { path: string; size: number } }>;
export function extractProvided(input: {
  sevenZipPath: string;
  archivePath: string;
  provides: NexusProvide[];
  gamePath: string;
  workDir: string;
  onProgress?: (index: number, count: number, file: string) => void;
}): Promise<{ installed: string[]; mismatched: string[] }>;
