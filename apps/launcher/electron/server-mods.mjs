/**
 * Mods the game server hosts (skymp/client-mods → game-api
 * /client-mods/manifest.json). Before PLAY the launcher:
 *
 *   1. fetches the manifest and validates it (paths stay inside Data/, never
 *      touch the base game masters);
 *   2. compares every listed file against the player's Data/ by SHA-256
 *      (with a size+mtime cache so big BSAs are not re-hashed every launch);
 *   3. after the player agrees, downloads what is missing/different to a temp
 *      file next to the target, verifies size + SHA-256, then renames it into
 *      place (never leaves a half-written mod);
 *   4. enables the server's plugins in OATHBOUND_plugins.txt /
 *      OATHBOUND_loadorder.txt, after the existing entries, in server order.
 *
 * Pure Node (no Electron) so it can be unit-tested; main.ts wires it to IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ServerModsError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ServerModsError';
    this.code = code;
  }
}

const PLUGIN_EXTENSIONS = new Set(['.esm', '.esp', '.esl']);
const BASE_MASTER_ORDER = Object.freeze(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']);
const BASE_MASTERS = new Set(BASE_MASTER_ORDER.map(p => p.toLowerCase()));

// The SkyMP client (Platform/, MpClientPlugin.dll, SkyrimPlatform.dll) comes
// from the server's mod list too: the launcher has no other way to install it,
// and the server's patched client must match the server. Only the base-game
// masters are never replaced.

export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every(seg =>
    seg.length > 0 && seg !== '.' && seg !== '..' &&
    // Control characters are rejected on purpose: Windows forbids them in names.
    // eslint-disable-next-line no-control-regex
    !/[<>:"|?*\x00-\x1f]/.test(seg) && !/[. ]$/.test(seg)
  );
}

/** @returns {{formatVersion:1, version:string, files:{path:string,size:number,sha256:string}[], plugins:string[], totalBytes:number}} */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.formatVersion !== 1) {
    throw new ServerModsError('INVALID_MANIFEST', 'The server sent an unknown mods manifest format.');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.plugins)) {
    throw new ServerModsError('INVALID_MANIFEST', 'The server mods manifest is incomplete.');
  }
  const seen = new Set();
  for (const f of manifest.files) {
    if (!f || !isSafeRelativePath(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256) ||
        !Number.isInteger(f.size) || f.size < 0) {
      throw new ServerModsError('INVALID_MANIFEST', `Invalid entry in the server mods manifest: ${f && f.path}`);
    }
    const lower = f.path.toLowerCase();
    if (seen.has(lower)) throw new ServerModsError('INVALID_MANIFEST', `Duplicate file in the server mods manifest: ${f.path}`);
    seen.add(lower);
    if (BASE_MASTERS.has(lower)) {
      throw new ServerModsError('PROTECTED_PATH', `The server tried to replace a protected file: ${f.path}`);
    }
  }
  // Base-game plugins (e.g. Creation Club masters of USSEP): required, never
  // downloaded — every Skyrim AE install ships them.
  const basePlugins = Array.isArray(manifest.basePlugins) ? manifest.basePlugins : [];
  const baseNames = new Set();
  for (const b of basePlugins) {
    if (!b || typeof b.name !== 'string' || b.name.includes('/') || b.name.includes('\\') ||
        !isSafeRelativePath(b.name) || !PLUGIN_EXTENSIONS.has(path.extname(b.name).toLowerCase()) ||
        !/^[0-9a-f]{64}$/.test(b.sha256)) {
      throw new ServerModsError('INVALID_MANIFEST', `Invalid base-game plugin in the server mods manifest: ${b && b.name}`);
    }
    baseNames.add(b.name.toLowerCase());
  }
  for (const plugin of manifest.plugins) {
    if (typeof plugin !== 'string' || plugin.includes('/') || !PLUGIN_EXTENSIONS.has(path.extname(plugin).toLowerCase()) ||
        !(seen.has(plugin.toLowerCase()) || baseNames.has(plugin.toLowerCase()))) {
      throw new ServerModsError('INVALID_MANIFEST', `Invalid plugin in the server mods manifest: ${plugin}`);
    }
  }
  return manifest;
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

export function dataPathOf(gamePath, rel) {
  const dataDir = path.resolve(gamePath, 'Data');
  const full = path.resolve(dataDir, ...rel.split('/'));
  if (!full.startsWith(dataDir + path.sep)) {
    throw new ServerModsError('PROTECTED_PATH', `Refusing to write outside Data/: ${rel}`);
  }
  return full;
}

/** size+mtime → sha256 cache, persisted as JSON (best effort). */
export function createHashCache(cacheFile) {
  let data = {};
  try { if (cacheFile && fs.existsSync(cacheFile)) data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { data = {}; }
  return {
    async hash(full) {
      const st = fs.statSync(full);
      const key = full.toLowerCase();
      const hit = data[key];
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
      const sha256 = await sha256File(full);
      data[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
      return sha256;
    },
    save() {
      if (!cacheFile) return;
      try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch { /* cache is optional */ }
    }
  };
}

/**
 * Which manifest files the player is missing or has a different version of.
 * @returns {Promise<{toDownload:object[], totalBytes:number, upToDate:number}>}
 */
export async function planServerModSync({ manifest, gamePath, hashCache }) {
  validateManifest(manifest);
  const cache = hashCache || createHashCache(null);
  const toDownload = [];
  let upToDate = 0;
  for (const entry of manifest.files) {
    const full = dataPathOf(gamePath, entry.path);
    let ok = false;
    try {
      const st = fs.statSync(full);
      ok = st.isFile() && st.size === entry.size && (await cache.hash(full)) === entry.sha256;
    } catch { ok = false; }
    if (ok) upToDate++; else toDownload.push(entry);
  }
  // Required base-game plugins the player does not have (not downloadable).
  const missingBase = [];
  for (const b of (manifest.basePlugins || [])) {
    try {
      if (!fs.statSync(dataPathOf(gamePath, b.name)).isFile()) missingBase.push(b.name);
    } catch { missingBase.push(b.name); }
  }
  return { toDownload, totalBytes: toDownload.reduce((s, f) => s + f.size, 0), upToDate, missingBase };
}

/**
 * Downloads, verifies and installs the planned files.
 * @param {{gamePath:string, baseUrl:string, toDownload:object[], fetchImpl?:typeof fetch,
 *          onProgress?:(p:{file:string, index:number, count:number, bytesDone:number, bytesTotal:number})=>void}} opts
 */
export async function installServerMods({ gamePath, baseUrl, toDownload, fetchImpl, onProgress, sleep, maxAttempts = 5 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Busy server (429/503, e.g. its per-IP file limit during a big first
  // install) or a dropped connection: wait and try the same file again
  // instead of failing a multi-GB install halfway. Honors Retry-After.
  const fetchWithRetry = async (url, label) => {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await doFetch(url);
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await wait(Math.min(30000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        try { await res.body?.cancel?.(); } catch { /* drain best effort */ }
        await wait(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(60000, retryAfter * 1000)
          : Math.min(30000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (!res.ok || !res.body) throw new ServerModsError('DOWNLOAD_FAILED', `HTTP ${res.status} downloading ${label}`);
      return res;
    }
  };
  const bytesTotal = toDownload.reduce((s, f) => s + f.size, 0);
  let bytesDone = 0;
  const installed = [];

  for (let index = 0; index < toDownload.length; index++) {
    const entry = toDownload[index];
    const full = dataPathOf(gamePath, entry.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.oathbound-download-${process.pid}`;
    const url = `${baseUrl.replace(/\/+$/, '')}/client-mods/files/${entry.path.split('/').map(encodeURIComponent).join('/')}`;

    try {
      const res = await fetchWithRetry(url, entry.path);
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(tmp, 'w');
      let size = 0;
      try {
        for await (const chunk of res.body) {
          const buf = Buffer.from(chunk);
          size += buf.length;
          if (size > entry.size) throw new ServerModsError('VERIFY_FAILED', `${entry.path} is larger than the manifest says.`);
          hash.update(buf);
          fs.writeSync(fd, buf);
          bytesDone += buf.length;
          onProgress?.({ file: entry.path, index, count: toDownload.length, bytesDone, bytesTotal });
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new ServerModsError('VERIFY_FAILED', `${entry.path} failed verification (corrupted or changed during download).`);
      }
      try { fs.rmSync(full, { force: true }); } catch { /* replaced below */ }
      fs.renameSync(tmp, full);
      installed.push(entry.path);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      if (err instanceof ServerModsError) throw err;
      throw new ServerModsError('DOWNLOAD_FAILED', `Could not download ${entry.path}: ${err?.message || err}`, err);
    }
  }
  return { installed };
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '') : [];
}

/**
 * Server-managed plugin set from the previous sync. It sits next to the lists
 * it describes, in the game folder, so it moves with the install.
 */
export const SERVER_PLUGINS_STATE_FILE = 'OATHBOUND_server-plugins.json';

/**
 * Plugins earlier servers sent and later renamed or dropped. Players whose
 * launcher synced before the state file existed have no record of what the
 * launcher put in their lists, so these names count as "previously
 * server-managed". Only list names that were never anything but a server
 * plugin.
 */
export const RETIRED_SERVER_PLUGINS = Object.freeze([
  'OathboundHoldstone.esp' // renamed to Oathbound_Holdstone.esp on 2026-11-22
]);

function readManagedState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.plugins) ? data.plugins.filter(p => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Ensures the server plugins are enabled, after everything already listed,
 * in server order. Existing lines (including the user's own) are preserved;
 * only entries for the server plugins are moved/enabled.
 *
 * Removal rule: a line is dropped only when its plugin was server-managed
 * before (in OATHBOUND_server-plugins.json from the last sync, or in
 * RETIRED_SERVER_PLUGINS) and the server no longer sends it. The player's own
 * entries and the five base masters are never removed. The plugin file in
 * Data/ is left alone: once it is out of the lists the game does not load it.
 *
 * Backs up each file before its first change.
 * @returns {{changed:boolean, removed:string[]}}
 */
export function enableServerPlugins({ gamePath, plugins }) {
  const lowerPlugins = new Set(plugins.map(p => p.toLowerCase()));
  const stateFile = path.join(gamePath, SERVER_PLUGINS_STATE_FILE);
  const stale = new Set(
    [...readManagedState(stateFile), ...RETIRED_SERVER_PLUGINS]
      .map(p => p.toLowerCase())
      .filter(p => !lowerPlugins.has(p) && !BASE_MASTERS.has(p))
  );
  const removed = new Map();
  let changed = false;

  const rewrite = (file, render) => {
    // A fresh install has no OATHBOUND list yet: start it with the five base
    // masters (the game's own order), then the server's plugins below. Without
    // this, PLAY failed with "OATHBOUND plugin list not found" for new players.
    const lines = fs.existsSync(file) ? readLines(file) : BASE_MASTER_ORDER.map(render);
    const kept = lines.filter(l => {
      const name = l.replace(/^\*/, '').trim();
      const lower = name.toLowerCase();
      if (stale.has(lower)) {
        removed.set(lower, name);
        return false;
      }
      return !lowerPlugins.has(lower);
    });
    const next = kept.concat(plugins.map(render));
    if (JSON.stringify(next) === JSON.stringify(lines)) return;
    if (fs.existsSync(file)) {
      const backup = `${file}.bak-server-mods-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, `${next.join('\r\n')}\r\n`);
    changed = true;
  };

  rewrite(path.join(gamePath, 'OATHBOUND_plugins.txt'), p => `*${p}`);
  rewrite(path.join(gamePath, 'OATHBOUND_loadorder.txt'), p => p);
  try {
    fs.writeFileSync(stateFile, `${JSON.stringify({ plugins }, null, 2)}\n`);
  } catch { /* the next sync just has less to clean up */ }
  return { changed, removed: [...removed.values()] };
}
