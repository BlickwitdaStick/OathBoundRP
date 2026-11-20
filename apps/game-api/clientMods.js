/**
 * clientMods.js — mods the SERVER hosts for its players.
 *
 * The operator extracts each mod into `skymp/client-mods/`, laid out exactly
 * as it must end up in the player's `Data/` folder:
 *
 *   skymp/client-mods/
 *     SkyUI_SE.esp
 *     SkyUI_SE.bsa
 *     RaceMenu.esp, RaceMenuPlugin.esp, RaceMenu.bsa
 *     SKSE/Plugins/skee64.dll, SKSE/Plugins/skee64.ini
 *     load-order.txt            (optional; plugin order, one per line)
 *
 * `scripts/sync-client-mods.js` turns that folder into:
 *   - `client-mods-manifest.json`, served at GET /client-mods/manifest.json,
 *     which the launcher compares against the player's Data/ (sha256);
 *   - the plugins copied into the SkyMP server's data dir and appended to its
 *     load order, so server and clients index FormIDs identically.
 *
 * Only files listed in the manifest are ever served, and every path is
 * validated as a plain relative path inside the folder.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_EXTENSIONS = new Set(['.esm', '.esp', '.esl']);

/** Files in the folder that are configuration, never distributed. */
const IGNORED_NAMES = new Set(['load-order.txt', 'readme.txt', '.gitkeep', 'thumbs.db', 'desktop.ini']);

/** Folders never distributed (e.g. RaceMenu ships C++ headers for modders). */
const IGNORED_DIRS = new Set(['moddersource', 'modderresource', 'fomod', 'docs', 'source', '.git']);

/** Vanilla masters are on every client already; never part of a mod pack. */
const BASE_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

// Guards against pointing the sync at the wrong folder (a whole drive, a Data
// folder full of loose files). Real packs grow: SkyUI + RaceMenu + city mods +
// Immersive Weapons/Armors + Cloaks are already ~6,300 files.
const MAX_FILES = 25000;

/**
 * A safe relative path: forward slashes, no `..`, no absolute/drive/UNC, no
 * empty or dot segments, no characters Windows forbids in names.
 * @param {string} rel
 */
function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  const segments = rel.split('/');
  return segments.every(seg =>
    seg.length > 0 && seg !== '.' && seg !== '..' &&
    !/[<>:"|?*\x00-\x1f]/.test(seg) &&
    !/[. ]$/.test(seg)
  );
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

function listFiles(rootDir) {
  const out = [];
  const walk = (dir, relPrefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        // Config/junk files are never distributed (load-order.txt is read
        // separately by buildClientModsManifest). Dotfiles neither: mods ship
        // `.placeholder` files just to keep empty folders (IED does), and the
        // download route refuses dotfiles, which would fail every install.
        if (IGNORED_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        out.push(rel);
        if (out.length > MAX_FILES) throw new Error(`Too many files in ${rootDir} (max ${MAX_FILES}).`);
      }
    }
  };
  walk(rootDir, '');
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Reads a plugin's TES4 header: ESM flag (0x1), light/ESL flag (0x200, or a
 * .esl extension) and its master list (MAST subrecords).
 *
 * This SkyMP build has NO ESL support (docs/technical/PLUGIN_LOAD_ORDER_STRATEGY.md):
 * the server gives a light plugin a full index, the game does not. See
 * planLoadOrder for how that is contained.
 * @param {string} fullPath
 * @returns {{esm:boolean, light:boolean, masters:string[]}}
 */
function readPluginHeader(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  const fd = fs.openSync(fullPath, 'r');
  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24 || head.toString('latin1', 0, 4) !== 'TES4') {
      throw new Error(`${path.basename(fullPath)} is not a valid plugin (no TES4 header).`);
    }
    const dataSize = head.readUInt32LE(4);
    const flags = head.readUInt32LE(8);
    const data = Buffer.alloc(Math.min(dataSize, 1 << 20));
    fs.readSync(fd, data, 0, data.length, 24);
    const masters = [];
    for (let o = 0; o + 6 <= data.length;) {
      const type = data.toString('latin1', o, o + 4);
      const size = data.readUInt16LE(o + 4);
      if (type === 'MAST') masters.push(data.toString('latin1', o + 6, o + 6 + size).replace(/\0+$/, ''));
      o += 6 + size;
    }
    return {
      esm: ext === '.esm' || ext === '.esl' || (flags & 0x1) !== 0,
      light: ext === '.esl' || (flags & 0x200) !== 0,
      masters
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Back-compat shape used by earlier callers/tests. */
function readPluginFlags(fullPath) {
  const h = readPluginHeader(fullPath);
  return { esm: h.esm, light: h.light };
}

/**
 * Orders plugins the way the GAME will load them, and derives the order the
 * SkyMP SERVER must use.
 *
 *  - Client (plugins.txt) order: every plugin after all of its masters; ESM-
 *    flagged plugins (incl. .esm/.esl) first, as the game hoists them anyway.
 *    Ties: `preferred` order (previous load order, then load-order.txt), then
 *    alphabetical — so existing plugins keep their place and new ones go to
 *    the end (PLUGIN_LOAD_ORDER_STRATEGY.md rule 4).
 *  - Server order: the same full plugins in the same effective order, then
 *    the light plugins LAST. The game gives light plugins no index; the server
 *    gives each one a full index. Putting them last on the server keeps every
 *    full plugin on the same index on both sides; only records defined in the
 *    light plugins themselves still disagree.
 *
 * @param {{name:string, esm:boolean, light:boolean, masters:string[]}[]} plugins
 * @param {{preferred?:string[], baseMasters?:string[]}} [opts]
 * @returns {{clientOrder:string[], serverOrder:string[], lightPlugins:string[]}}
 */
function planLoadOrder(plugins, opts = {}) {
  const base = new Set((opts.baseMasters || BASE_MASTERS).map(n => n.toLowerCase()));
  const byLower = new Map(plugins.map(p => [p.name.toLowerCase(), p]));
  const pref = new Map();
  (opts.preferred || []).forEach((n, i) => { if (!pref.has(n.toLowerCase())) pref.set(n.toLowerCase(), i); });
  const prio = (p) => (pref.has(p.name.toLowerCase()) ? pref.get(p.name.toLowerCase()) : Infinity);
  const cmp = (a, b) => prio(a) - prio(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());

  for (const p of plugins) {
    for (const m of p.masters) {
      const ml = m.toLowerCase();
      if (!base.has(ml) && !byLower.has(ml)) {
        throw new Error(`${p.name} requires ${m}, which is neither hosted in client-mods nor a known base-game plugin.`);
      }
      const mp = byLower.get(ml);
      if (mp && p.esm && !mp.esm) {
        throw new Error(`${p.name} is a master (ESM) but depends on non-master ${m}; the game cannot load that.`);
      }
    }
  }

  const placed = new Set();
  const clientOrder = [];
  for (const group of [plugins.filter(p => p.esm), plugins.filter(p => !p.esm)]) {
    const pending = new Set(group);
    while (pending.size > 0) {
      const ready = [...pending]
        .filter(p => p.masters.every(m => base.has(m.toLowerCase()) || placed.has(m.toLowerCase())))
        .sort(cmp);
      if (ready.length === 0) {
        throw new Error(`Circular or unsatisfiable masters among: ${[...pending].map(p => p.name).join(', ')}`);
      }
      const next = ready[0];
      pending.delete(next);
      placed.add(next.name.toLowerCase());
      clientOrder.push(next.name);
    }
  }
  const light = new Set(plugins.filter(p => p.light).map(p => p.name));

  // Patched SkyMP (patches/skymp/light-plugins, ported from ThornswoodRP #1715):
  // the server reads each plugin's light flag and gives light plugins the
  // game's own FE-space ids, so it loads EXACTLY the game's order.
  if (opts.serverSupportsLightPlugins) {
    return { clientOrder, serverOrder: clientOrder.slice(), lightPlugins: clientOrder.filter(n => light.has(n)) };
  }

  // Stock SkyMP: `.esl` files are NOT listed for the server at all: this SkyMP build refuses
  // them by name at boot ("'_ResourcePack.esl' is not a valid esp or esm name",
  // manifestGen.ts) and crashed on startup. Leaving them out also matches the
  // game exactly: a light plugin takes no numbered slot there either.
  // ESL-flagged .esp files can be loaded by the server, so those go last.
  const isEslFile = (n) => path.extname(n).toLowerCase() === '.esl';
  const serverOrder = clientOrder.filter(n => !light.has(n))
    .concat(clientOrder.filter(n => light.has(n) && !isEslFile(n)));

  // This SkyMP build also refuses a plugin whose masters it has not loaded
  // ("X has unresolved dependency (Y.esl)" — the server stops). So a server
  // plugin may never depend on a .esl file. Fail here, with the reason, instead
  // of letting the game server crash at boot.
  const onServer = new Set([...base, ...serverOrder.map(n => n.toLowerCase())]);
  const blocked = [];
  for (const name of serverOrder) {
    const p = byLower.get(name.toLowerCase());
    for (const m of p.masters) {
      if (!onServer.has(m.toLowerCase())) blocked.push(`${name} needs ${m}`);
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `This SkyMP server cannot load .esl plugins, and refuses plugins whose masters it has not loaded: ${blocked.join('; ')}. ` +
      'Remove these mods (and anything that requires them) from client-mods, or use a SkyMP build with light-plugin support.'
    );
  }

  return { clientOrder, serverOrder, lightPlugins: clientOrder.filter(n => light.has(n)) };
}

/** Old API kept for callers/tests: names + optional load-order.txt + flags. */
function orderPlugins(pluginNames, loadOrderText, flagsOf) {
  const preferred = [];
  if (typeof loadOrderText === 'string') {
    const names = new Set(pluginNames.map(n => n.toLowerCase()));
    for (const raw of loadOrderText.split(/\r?\n/)) {
      const line = raw.replace(/^\*/, '').trim();
      if (!line || line.startsWith('#')) continue;
      if (!names.has(line.toLowerCase())) throw new Error(`load-order.txt lists "${line}", which is not in the client-mods folder.`);
      preferred.push(line);
    }
  }
  const flags = (n) => (flagsOf ? flagsOf(n) : {
    esm: ['.esm', '.esl'].includes(path.extname(n).toLowerCase()),
    light: path.extname(n).toLowerCase() === '.esl'
  });
  const plan = planLoadOrder(pluginNames.map(n => ({ name: n, ...flags(n), masters: [] })), { preferred });
  return plan.serverOrder;
}

/**
 * Scans the folder and returns the manifest the launcher consumes.
 * @param {string} rootDir
 */
/**
 * @param {string} rootDir
 * @param {{hashCachePath?:string}} [opts] size+mtime → sha256 cache, so a
 *   multi-GB folder is not re-hashed on every server start.
 */
async function buildClientModsManifest(rootDir, opts = {}) {
  let cache = {};
  if (opts.hashCachePath) {
    try { cache = JSON.parse(fs.readFileSync(opts.hashCachePath, 'utf8')) || {}; } catch { cache = {}; }
  }
  const nextCache = {};
  if (!fs.existsSync(rootDir)) {
    return { formatVersion: 1, version: 'empty', files: [], plugins: [], serverLoadOrder: [], basePlugins: [], lightPlugins: [], totalBytes: 0 };
  }
  const relPaths = listFiles(rootDir);
  const files = [];
  for (const rel of relPaths) {
    if (!isSafeRelativePath(rel)) throw new Error(`Unsafe file name in client-mods: ${rel}`);
    const full = path.join(rootDir, ...rel.split('/'));
    const st = fs.statSync(full);
    const hit = cache[rel];
    const sha256 = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.sha256 : await sha256File(full);
    nextCache[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
    files.push({ path: rel, size: st.size, sha256 });
  }

  const rootPlugins = relPaths.filter(rel => !rel.includes('/') && PLUGIN_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const nested = relPaths.filter(rel => rel.includes('/') && PLUGIN_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  if (nested.length > 0) {
    throw new Error(`Plugins must sit at the root of client-mods (like Data/): ${nested.join(', ')}`);
  }
  for (const master of BASE_MASTERS) {
    if (rootPlugins.some(p => p.toLowerCase() === master.toLowerCase())) {
      throw new Error(`${master} is a base game master; do not put it in client-mods.`);
    }
  }

  const loadOrderPath = path.join(rootDir, 'load-order.txt');
  const loadOrderText = fs.existsSync(loadOrderPath) ? fs.readFileSync(loadOrderPath, 'utf8') : null;

  // Hosted plugins + any base-game plugins they need (e.g. Creation Club
  // masters of USSEP), discovered through their master lists. Base plugins are
  // NOT distributed: every player has them; the launcher only checks they exist.
  const headers = rootPlugins.map(p => ({ name: p, ...readPluginHeader(path.join(rootDir, p)) }));
  const hostedLower = new Set(rootPlugins.map(p => p.toLowerCase()));
  const baseLower = new Set(BASE_MASTERS.map(m => m.toLowerCase()));
  const basePlugins = [];
  const queue = headers.flatMap(h => h.masters);
  const seenBase = new Set();
  while (queue.length > 0) {
    const m = queue.shift();
    const ml = m.toLowerCase();
    if (baseLower.has(ml) || hostedLower.has(ml) || seenBase.has(ml)) continue;
    seenBase.add(ml);
    const found = opts.baseDataDir && fs.existsSync(opts.baseDataDir)
      ? fs.readdirSync(opts.baseDataDir).find(n => n.toLowerCase() === ml)
      : null;
    if (!found) {
      const who = headers.filter(h => h.masters.some(x => x.toLowerCase() === ml)).map(h => h.name);
      throw new Error(`${who.join(', ')} require(s) ${m}, which is not in client-mods` +
        (opts.baseDataDir ? ` nor in the game Data folder (${opts.baseDataDir}).` : ' and no base game Data folder is configured.'));
    }
    const full = path.join(opts.baseDataDir, found);
    const h = { name: found, ...readPluginHeader(full) };
    headers.push(h);
    queue.push(...h.masters);
    const st = fs.statSync(full);
    const key = `base:${found}`;
    const hit = cache[key];
    const sha256 = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.sha256 : await sha256File(full);
    nextCache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
    basePlugins.push({ name: found, size: st.size, sha256 });
  }

  const preferred = [...(opts.previousPlugins || [])];
  if (typeof loadOrderText === 'string') {
    for (const raw of loadOrderText.split(/\r?\n/)) {
      const line = raw.replace(/^\*/, '').trim();
      if (!line || line.startsWith('#')) continue;
      if (!headers.some(h => h.name.toLowerCase() === line.toLowerCase())) {
        throw new Error(`load-order.txt lists "${line}", which is not in the client-mods folder.`);
      }
      preferred.push(line);
    }
  }
  const plan = planLoadOrder(headers, { preferred, serverSupportsLightPlugins: !!opts.serverSupportsLightPlugins });
  const plugins = plan.clientOrder;
  const serverLoadOrder = plan.serverOrder;
  const lightPlugins = plan.lightPlugins;

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const version = crypto.createHash('sha256')
    .update(JSON.stringify({ files: files.map(f => [f.path, f.sha256]), plugins, basePlugins }))
    .digest('hex')
    .slice(0, 16);

  if (opts.hashCachePath) {
    try { fs.writeFileSync(opts.hashCachePath, JSON.stringify(nextCache)); } catch { /* cache is optional */ }
  }
  return { formatVersion: 1, version, files, plugins, serverLoadOrder, basePlugins, lightPlugins, totalBytes };
}

/**
 * Validates a manifest object loaded from disk before serving it.
 * @returns {{ok:true, manifest:object}|{ok:false, reason:string}}
 */
function validateClientModsManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'not_an_object' };
  if (manifest.formatVersion !== 1) return { ok: false, reason: 'unknown_format' };
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.plugins)) return { ok: false, reason: 'missing_lists' };
  for (const f of manifest.files) {
    if (!f || !isSafeRelativePath(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) {
      return { ok: false, reason: 'invalid_file_entry' };
    }
  }
  return { ok: true, manifest };
}

/**
 * Loader with mtime cache, mirroring modsManifest.js. A missing manifest is
 * "no server mods" (valid, empty), not an error: servers without mods still work.
 */
function createClientModsLoader(manifestPath) {
  let cache = null;
  let cachedMtime = null;
  return {
    load() {
      let stat;
      try { stat = fs.statSync(manifestPath); } catch {
        return { ok: true, manifest: { formatVersion: 1, version: 'empty', files: [], plugins: [], totalBytes: 0 } };
      }
      if (cache && cachedMtime === stat.mtimeMs) return cache;
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {
        cache = { ok: false, reason: 'invalid_json' };
        cachedMtime = stat.mtimeMs;
        return cache;
      }
      cache = validateClientModsManifest(parsed);
      cachedMtime = stat.mtimeMs;
      return cache;
    }
  };
}

/**
 * Resolves a requested path to a file on disk, only if it is listed in the
 * manifest. Returns null otherwise (caller answers 404).
 */
function resolveServedFile(rootDir, manifest, requestedPath) {
  if (!isSafeRelativePath(requestedPath)) return null;
  const entry = manifest.files.find(f => f.path === requestedPath);
  if (!entry) return null;
  const full = path.resolve(rootDir, ...requestedPath.split('/'));
  const root = path.resolve(rootDir) + path.sep;
  if (!full.startsWith(root)) return null;
  return { full, entry };
}

module.exports = {
  BASE_MASTERS,
  isSafeRelativePath,
  readPluginFlags,
  readPluginHeader,
  planLoadOrder,
  orderPlugins,
  buildClientModsManifest,
  validateClientModsManifest,
  createClientModsLoader,
  resolveServedFile
};
