/**
 * Hosted mods from Nexus Mods instead of the game server.
 *
 * The server manifest (/client-mods/manifest.json) may carry a `nexus` list:
 * Nexus archives and, for each, which archive file becomes which Data file.
 * Before PLAY the launcher:
 *
 *   1. plans which archives cover the player's missing files (planNexusDownloads);
 *   2. gets a download link from the Nexus API — Premium accounts directly,
 *      free accounts through the nxm:// link the "Mod Manager Download" button
 *      on the Nexus page hands to the launcher;
 *   3. downloads the archive next to the game, lists it with 7-Zip, extracts
 *      only the needed files and checks each one's size + SHA-256 against the
 *      server manifest before moving it into Data/ (extractProvided);
 *   4. whatever is still missing (OATHBOUND's own files, edited files, an
 *      archive the player skipped or that Nexus no longer serves) is downloaded
 *      from the game server as before (server-mods.mjs).
 *
 * Pure Node (no Electron) so it can be unit-tested; main.ts wires it to IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { isSafeRelativePath, dataPathOf } from './server-mods.mjs';

export const NEXUS_API = 'https://api.nexusmods.com';
export const NEXUS_API_KEY_PAGE = 'https://next.nexusmods.com/settings/api-keys';
// Hard ceiling for an archive whose size Nexus does not report (size 0).
const MAX_UNKNOWN_ARCHIVE_BYTES = 32 * 1024 * 1024 * 1024;
const GAME_DOMAIN = /^[a-z0-9]+$/;

export class NexusError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NexusError';
    this.code = code;
  }
}

/**
 * Sanitized `nexus` list from a validated server manifest. Entries that are
 * malformed or point at files the manifest does not list are dropped (those
 * files simply come from the server).
 */
export function nexusSourcesOf(manifest) {
  if (!manifest || !Array.isArray(manifest.nexus)) return [];
  const byPath = new Map(manifest.files.map(f => [f.path, f]));
  const out = [];
  for (const s of manifest.nexus) {
    if (!s || !Number.isInteger(s.modId) || s.modId <= 0 || !Number.isInteger(s.fileId) || s.fileId <= 0 ||
        typeof s.fileName !== 'string' || s.fileName.includes('/') || s.fileName.includes('\\') ||
        !isSafeRelativePath(s.fileName) || !Number.isInteger(s.size) || s.size < 0 || !Array.isArray(s.provides) ||
        (s.game !== undefined && !GAME_DOMAIN.test(String(s.game)))) {
      continue;
    }
    const provides = [];
    for (const p of s.provides) {
      const entry = p && byPath.get(p.path);
      if (!entry || !isSafeRelativePath(p.src)) continue;
      provides.push({ src: p.src, path: entry.path, size: entry.size, sha256: entry.sha256 });
    }
    if (provides.length === 0) continue;
    out.push({
      id: String(s.id || s.modId),
      name: String(s.name || s.fileName).slice(0, 200),
      game: s.game ? String(s.game) : 'skyrimspecialedition',
      modId: s.modId,
      fileId: s.fileId,
      version: s.version ? String(s.version).slice(0, 50) : '',
      fileName: s.fileName,
      size: s.size,
      provides
    });
  }
  return out;
}

/**
 * Splits the missing files between Nexus archives and the game server.
 * An archive is only worth it when it covers a fair share of its own size:
 * downloading a 7 GB pack to fix three small files is worse than getting
 * those files from the server.
 * @returns {{archives:{source:object, provides:object[], bytes:number}[], remaining:object[], nexusBytes:number, serverBytes:number}}
 */
export function planNexusDownloads({ sources, toDownload, minShare = 0.05, smallArchiveBytes = 100 * 1024 * 1024 }) {
  const missing = new Map(toDownload.map(f => [f.path, f]));
  const taken = new Set();
  const archives = [];
  for (const source of sources) {
    const provides = source.provides.filter(p => missing.has(p.path) && !taken.has(p.path));
    if (provides.length === 0) continue;
    const bytes = provides.reduce((s, p) => s + p.size, 0);
    if (source.size > smallArchiveBytes && bytes < source.size * minShare) continue;
    for (const p of provides) taken.add(p.path);
    archives.push({ source, provides, bytes });
  }
  const remaining = toDownload.filter(f => !taken.has(f.path));
  return {
    archives,
    remaining,
    nexusBytes: archives.reduce((s, a) => s + a.source.size, 0),
    serverBytes: remaining.reduce((s, f) => s + f.size, 0)
  };
}

/** nxm://skyrimspecialedition/mods/12604/files/749043?key=..&expires=..&user_id=.. */
export function parseNxmUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'nxm:') return null;
  const game = u.hostname.toLowerCase();
  const m = /^\/mods\/(\d+)\/files\/(\d+)\/?$/.exec(u.pathname);
  if (!m || !GAME_DOMAIN.test(game)) return null;
  const key = u.searchParams.get('key');
  const expires = u.searchParams.get('expires');
  return {
    game,
    modId: Number(m[1]),
    fileId: Number(m[2]),
    key: key || null,
    expires: expires && /^\d+$/.test(expires) ? expires : null
  };
}

/** Page whose "Mod Manager Download" button sends this file's nxm:// link. */
export function nexusFilePageUrl(source) {
  return `https://www.nexusmods.com/${source.game}/mods/${source.modId}?tab=files&file_id=${source.fileId}&nmm=1`;
}

export function createNexusApi({ apiKey, appName, appVersion, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = {
    apikey: apiKey,
    'Application-Name': appName,
    'Application-Version': appVersion,
    accept: 'application/json'
  };
  const get = async (pathname) => {
    let res;
    try {
      res = await doFetch(`${NEXUS_API}${pathname}`, { headers, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new NexusError('NETWORK', `Could not reach Nexus Mods: ${err?.message || err}`, err);
    }
    if (res.status === 401) throw new NexusError('BAD_KEY', 'Nexus Mods rejected the API key. Paste a new one.');
    if (res.status === 403) throw new NexusError('FORBIDDEN', 'Nexus Mods refused the download (a free account needs the "Mod Manager Download" button).');
    if (res.status === 404) throw new NexusError('NOT_FOUND', 'That file is no longer on Nexus Mods.');
    if (res.status === 429) throw new NexusError('RATE_LIMITED', 'Nexus Mods download limit reached for today.');
    if (!res.ok) throw new NexusError('HTTP', `Nexus Mods answered HTTP ${res.status}.`);
    return res.json();
  };
  return {
    /** @returns {Promise<{name:string, isPremium:boolean}>} */
    async validate() {
      const j = await get('/v1/users/validate.json');
      return { name: String(j.name || ''), isPremium: !!(j.is_premium || j['is_premium?']) };
    },
    /** @returns {Promise<string>} a CDN URL for the archive */
    async downloadLink(source, nxm) {
      const q = nxm && nxm.key && nxm.expires
        ? `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(nxm.expires)}`
        : '';
      const links = await get(`/v1/games/${source.game}/mods/${source.modId}/files/${source.fileId}/download_link.json${q}`);
      const uri = Array.isArray(links) && links.find(l => l && typeof l.URI === 'string')?.URI;
      if (!uri || !/^https:\/\//i.test(uri)) throw new NexusError('NO_LINK', 'Nexus Mods returned no download link.');
      return uri;
    }
  };
}

/**
 * Streams the archive to `dest` (via a .part file). An existing `dest` with
 * the right size is reused, so a failed install does not download again.
 */
export async function downloadArchive({ url, dest, expectedSize, fetchImpl, onProgress }) {
  // expectedSize 0 = Nexus did not say; accept any size under the ceiling.
  const limit = expectedSize > 0 ? expectedSize : MAX_UNKNOWN_ARCHIVE_BYTES;
  if (expectedSize > 0 && fs.existsSync(dest) && fs.statSync(dest).size === expectedSize) return { reused: true };
  const doFetch = fetchImpl || globalThis.fetch;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let res;
  try { res = await doFetch(url); } catch (err) {
    throw new NexusError('DOWNLOAD_FAILED', `Download failed: ${err?.message || err}`, err);
  }
  if (!res.ok || !res.body) throw new NexusError('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`);
  const fd = fs.openSync(part, 'w');
  let done = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      done += buf.length;
      if (done > limit) throw new NexusError('VERIFY_FAILED', 'The archive is larger than Nexus said.');
      fs.writeSync(fd, buf);
      onProgress?.(done, expectedSize);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
    if (err instanceof NexusError) throw err;
    throw new NexusError('DOWNLOAD_FAILED', `Download interrupted: ${err?.message || err}`, err);
  }
  fs.closeSync(fd);
  if (expectedSize > 0 && done !== expectedSize) {
    try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
    throw new NexusError('VERIFY_FAILED', `The archive is ${done} bytes, expected ${expectedSize}.`);
  }
  try { fs.rmSync(dest, { force: true }); } catch { /* replaced below */ }
  fs.renameSync(part, dest);
  return { reused: false };
}

function run7z(sevenZipPath, args) {
  return new Promise((resolve, reject) => {
    execFile(sevenZipPath, args, { maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new NexusError('EXTRACT_FAILED', `7-Zip failed: ${String(stderr || err.message).trim().slice(0, 300)}`, err));
      else resolve(stdout);
    });
  });
}

/** `7za l -slt -ba` output → [{path, size}] (files only). */
export function parse7zList(stdout) {
  const entries = [];
  for (const block of String(stdout).split(/\r?\n\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 3);
    }
    if (!fields.Path || fields.Folder === '+' || (fields.Attributes || '').startsWith('D')) continue;
    entries.push({ path: fields.Path.replace(/\\/g, '/'), size: Number(fields.Size) });
  }
  return entries;
}

/**
 * Archive entry for each provided file: exact path, then "ends with /src"
 * (the archive has an extra top folder), then same file name + size.
 */
export function matchArchiveEntries(entries, provides) {
  const byLower = new Map(entries.map(e => [e.path.toLowerCase(), e]));
  const matches = [];
  for (const p of provides) {
    const src = p.src.toLowerCase();
    let hit = byLower.get(src) || entries.find(e => e.path.toLowerCase().endsWith(`/${src}`));
    if (!hit) {
      const base = path.posix.basename(src);
      hit = entries.find(e => e.size === p.size && path.posix.basename(e.path.toLowerCase()) === base);
    }
    if (hit) matches.push({ provide: p, entry: hit });
  }
  return matches;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Extracts only the provided files and installs the ones whose size and
 * SHA-256 match the manifest. Files that do not match are left for the
 * server download.
 * @returns {Promise<{installed:string[], mismatched:string[]}>}
 */
export async function extractProvided({ sevenZipPath, archivePath, provides, gamePath, workDir, onProgress }) {
  const entries = parse7zList(await run7z(sevenZipPath, ['l', '-slt', '-ba', '-sccUTF-8', archivePath]));
  const matches = matchArchiveEntries(entries, provides);
  const installed = [];
  const mismatched = provides.filter(p => !matches.some(m => m.provide === p)).map(p => p.path);
  if (matches.length === 0) return { installed, mismatched };

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const listFile = path.join(workDir, '..', `${path.basename(workDir)}.list.txt`);
    const unique = [...new Set(matches.map(m => m.entry.path))];
    fs.writeFileSync(listFile, unique.map(p => p.replace(/\//g, '\\')).join('\r\n'), 'utf8');
    try {
      await run7z(sevenZipPath, ['x', archivePath, `-o${workDir}`, `-i@${listFile}`, '-scsUTF-8', '-sccUTF-8', '-y', '-bd']);
    } finally {
      try { fs.rmSync(listFile, { force: true }); } catch { /* best effort */ }
    }

    let index = 0;
    for (const { provide, entry } of matches) {
      onProgress?.(index++, matches.length, provide.path);
      const extracted = path.join(workDir, ...entry.path.split('/'));
      let ok = false;
      try {
        ok = fs.statSync(extracted).size === provide.size && (await sha256File(extracted)) === provide.sha256;
      } catch { ok = false; }
      if (!ok) { mismatched.push(provide.path); continue; }
      const full = dataPathOf(gamePath, provide.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.oathbound-nexus-${process.pid}`;
      // One archive file can fill several Data paths: copy, never move.
      fs.copyFileSync(extracted, tmp);
      try { fs.rmSync(full, { force: true }); } catch { /* replaced below */ }
      fs.renameSync(tmp, full);
      installed.push(provide.path);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { installed, mismatched };
}
