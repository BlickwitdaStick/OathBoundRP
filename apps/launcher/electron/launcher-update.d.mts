export const UPDATE_REPO: string;

export interface LauncherInstaller {
  version: string;
  url: string;
  size: number;
  name: string;
  release: string;
  notes: string;
}

export function parseVersion(v: string): [number, number, number] | null;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function newestInstaller(releases: unknown): LauncherInstaller | null;
export function isTrustedDownloadUrl(url: string): boolean;
export function checkLauncherUpdate(opts: { currentVersion: string; fetchImpl?: typeof fetch }): Promise<{
  current: string;
  available: boolean;
  latest: LauncherInstaller | null;
}>;
export function downloadInstaller(opts: {
  latest: LauncherInstaller;
  dir: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<string>;
