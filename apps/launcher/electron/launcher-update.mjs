/**
 * Launcher self-update from the OATHBOUND GitHub fork.
 *
 * A new launcher is published as a GitHub Release asset named like the
 * installer electron-builder makes, "OATHBOUND RP Launcher Setup X.Y.Z.exe"
 * (GitHub turns the spaces into dots). The launcher reads the public releases
 * list, picks the highest version above its own, downloads the installer to
 * the temp folder (size checked), starts it and quits so it can be replaced.
 *
 * Pure Node (no Electron) so it can be unit-tested; main.ts wires it to IPC.
 */

import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_REPO = 'BlickwitdaStick/OathBoundRP';
const ASSET_RE = /^OATHBOUND[ ._-]RP[ ._-]Launcher[ ._-]Setup[ ._-](\d+)\.(\d+)\.(\d+)\.exe$/i;

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The newest launcher installer across the releases list.
 * @returns {{version:string, url:string, size:number, name:string, release:string, notes:string}|null}
 */
export function newestInstaller(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue;
    for (const a of Array.isArray(r.assets) ? r.assets : []) {
      const m = ASSET_RE.exec(a && a.name ? a.name : '');
      if (!m || !a.browser_download_url) continue;
      const version = `${m[1]}.${m[2]}.${m[3]}`;
      if (!best || compareVersions(version, best.version) > 0) {
        best = {
          version,
          url: a.browser_download_url,
          size: Number(a.size) || 0,
          name: a.name,
          release: r.name || r.tag_name || '',
          notes: String(r.body || '').slice(0, 2000)
        };
      }
    }
  }
  return best;
}

/** Only GitHub's own download hosts may serve the installer. */
export function isTrustedDownloadUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      u.pathname.startsWith(`/${UPDATE_REPO}/releases/download/`);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{current:string, available:boolean, latest:object|null}>}
 */
export async function checkLauncherUpdate({ currentVersion, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OATHBOUND-Launcher' }
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} while checking for a launcher update.`);
  const latest = newestInstaller(await res.json());
  return {
    current: currentVersion,
    available: Boolean(latest && compareVersions(latest.version, currentVersion) > 0),
    latest
  };
}

/** Downloads the installer to `dir`; returns its path. Size is verified. */
export async function downloadInstaller({ latest, dir, fetchImpl = fetch, onProgress }) {
  if (!latest || !isTrustedDownloadUrl(latest.url)) throw new Error('The update does not come from the OATHBOUND GitHub releases.');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `OATHBOUND-Launcher-Setup-${latest.version}.exe`);
  const tmp = `${dest}.part`;
  const res = await fetchImpl(latest.url, { headers: { 'User-Agent': 'OATHBOUND-Launcher' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || latest.size || 0;
  const out = fs.createWriteStream(tmp);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ done, total });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (latest.size && done !== latest.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`The download is incomplete (${done} of ${latest.size} bytes). Try again.`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}
