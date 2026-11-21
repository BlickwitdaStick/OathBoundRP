#!/usr/bin/env node
/**
 * sync-client-mods.js
 *
 * Makes the server match `skymp/client-mods/` (see clientMods.js):
 *
 *   1. writes apps/game-api/client-mods-manifest.json (what the launcher
 *      downloads and verifies);
 *   2. copies the mod plugins into the SkyMP server's data dir and puts them
 *      in `server-settings.json` `loadOrder`, right after the existing
 *      entries — the server must load exactly what clients load, or FormID
 *      indexes diverge (docs/technical/MODS_AND_GAMEMODE_CONTRACT.md §3);
 *   3. regenerates apps/game-api/mods.json (the launcher's parity gate) from
 *      that load order.
 *
 * Plugins this script added earlier and that are no longer in client-mods
 * are removed from the load order and the server data dir. Anything it did
 * not add (base masters, manual entries) is never touched.
 *
 * Every file it rewrites is backed up next to itself first. Runs on every
 * start from scripts/phase0/Start-AllServices.ps1; safe to re-run.
 *
 * Usage:
 *   node scripts/sync-client-mods.js            apply
 *   node scripts/sync-client-mods.js --check    print the plan, change nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildClientModsManifest } = require('../clientMods');
const { attachNexusSources, readNexusRecipe } = require('../nexusSources');

const GAME_API_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(GAME_API_DIR, '..', '..');

const DEFAULTS = {
  clientModsDir: process.env.CLIENT_MODS_DIR || path.join(REPO_DIR, 'skymp', 'client-mods'),
  serverSettingsPath: path.join(REPO_DIR, 'skymp', 'server', 'server-settings.json'),
  modsJsonPath: process.env.MODS_MANIFEST_PATH || path.join(GAME_API_DIR, 'mods.json'),
  manifestOutPath: process.env.CLIENT_MODS_MANIFEST_PATH || path.join(GAME_API_DIR, 'client-mods-manifest.json'),
  // Which Nexus archive holds which client-mods file: the launcher downloads
  // those from Nexus instead of this server. Optional.
  nexusRecipePath: process.env.NEXUS_SOURCES_PATH || path.join(REPO_DIR, 'skymp', 'config', 'nexus-sources.json')
};

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function backupAndWrite(filePath, contents, log) {
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, 'utf8') === contents) return false;
    const backup = `${filePath}.bak-client-mods-${stamp()}`;
    fs.copyFileSync(filePath, backup);
    log(`  backup: ${path.basename(backup)}`);
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
  return true;
}

/**
 * Base game Data folder (where Creation Club masters like
 * ccBGSSSE001-Fish.esm live). Needed when a hosted mod lists one as a master:
 * the server must load the same plugin. BASE_GAME_DATA_DIR wins, else
 * skymp/config/client-mods.local.json { "baseGameDataDir": "..." }.
 */
function readLocalConfig() {
  const cfg = path.join(REPO_DIR, 'skymp', 'config', 'client-mods.local.json');
  try { return JSON.parse(fs.readFileSync(cfg, 'utf8')) || {}; } catch { return {}; }
}

function resolveBaseDataDir() {
  const dir = process.env.BASE_GAME_DATA_DIR || readLocalConfig().baseGameDataDir || null;
  // A relative path is relative to the repository, so a hosted server with no
  // Skyrim install can point at its own data folder ("skymp/data"), which
  // already holds the base-game masters the mods need.
  return dir && !path.isAbsolute(dir) ? path.resolve(REPO_DIR, dir) : dir;
}

/**
 * true only when skymp/server runs the patched SkyMP with light-plugin support
 * (patches/manifest.json "light-plugins"). A stock server refuses .esl files.
 */
function resolveLightPluginSupport() {
  if (process.env.SKYMP_LIGHT_PLUGINS) return process.env.SKYMP_LIGHT_PLUGINS === 'true';
  return readLocalConfig().serverSupportsLightPlugins === true;
}

/**
 * @param {{clientModsDir:string, serverSettingsPath:string, modsJsonPath:string,
 *          manifestOutPath:string, baseDataDir?:string|null, hashCachePath?:string|null,
 *          check?:boolean, log?:(s:string)=>void}} opts
 */
async function syncClientMods(opts) {
  const o = { ...DEFAULTS, ...opts };
  const log = o.log || (() => {});
  const check = !!o.check;
  const baseDataDir = o.baseDataDir === undefined ? resolveBaseDataDir() : o.baseDataDir;

  const lightSupported = o.serverSupportsLightPlugins === undefined ? resolveLightPluginSupport() : !!o.serverSupportsLightPlugins;

  const previous = fs.existsSync(o.manifestOutPath) ? readJson(o.manifestOutPath) : null;
  const manifest = await buildClientModsManifest(o.clientModsDir, {
    hashCachePath: o.hashCachePath === undefined ? path.join(GAME_API_DIR, 'client-mods-hash-cache.json') : o.hashCachePath,
    baseDataDir,
    // Existing plugins keep their place; new ones go after (PLUGIN_LOAD_ORDER_STRATEGY.md rule 4).
    previousPlugins: (previous && previous.plugins) || [],
    serverSupportsLightPlugins: lightSupported
  });
  log(`[client-mods] ${manifest.files.length} file(s), ${manifest.plugins.length} plugin(s), ${(manifest.totalBytes / 1048576).toFixed(1)} MB, version ${manifest.version}`);
  const nexus = attachNexusSources(o.nexusRecipePath ? readNexusRecipe(o.nexusRecipePath) : null, manifest);
  manifest.nexus = nexus.sources;
  if (nexus.sources.length > 0) {
    const covered = new Set(nexus.sources.flatMap(s => s.provides.map(p => p.path)));
    const coveredBytes = manifest.files.filter(f => covered.has(f.path)).reduce((sum, f) => sum + f.size, 0);
    log(`[client-mods] Nexus: ${nexus.sources.length} archive(s) provide ${covered.size} file(s), ${(coveredBytes / 1048576).toFixed(1)} MB; the rest is served from here`);
  }
  for (const d of nexus.dropped) log(`[client-mods] Nexus source skipped: ${d}`);
  if (manifest.basePlugins.length > 0) {
    log(`[client-mods] base-game plugins required (not distributed; every player has them): ${manifest.basePlugins.map(b => b.name).join(', ')}`);
  }

  const previouslySynced = new Set(((previous && previous.plugins) || []).map(p => p.toLowerCase()));
  const nowSynced = new Set(manifest.plugins.map(p => p.toLowerCase()));

  // ── Server settings: load order and data dir ─────────────────────────────
  const settings = readJson(o.serverSettingsPath);
  if (!Array.isArray(settings.loadOrder)) throw new Error('server-settings.json has no loadOrder array.');
  const dataDir = path.resolve(path.dirname(o.serverSettingsPath), settings.dataDir || 'data');
  if (!fs.existsSync(dataDir)) throw new Error(`Server data dir not found: ${dataDir}`);

  // Entries the sync did not add (base masters, manual ones) keep their place.
  const kept = settings.loadOrder.filter(p => {
    const lower = String(p).toLowerCase();
    return !previouslySynced.has(lower) && !nowSynced.has(lower);
  });
  // Two lists on purpose:
  //  - server-settings.json: SkyMP's index order, light (ESL) plugins LAST so
  //    every full plugin has the same index as in the game;
  //  - mods.json: the GAME's order (masters before dependents), which the
  //    launcher's parity check compares the player's plugins.txt against.
  const serverLoadOrder = kept.concat(manifest.serverLoadOrder);
  const clientLoadOrder = kept.concat(manifest.plugins);
  const removed = [...previouslySynced].filter(p => !nowSynced.has(p));

  const baseByLower = new Map(manifest.basePlugins.map(b => [b.name.toLowerCase(), b]));
  const sourceOf = (plugin) => (baseByLower.has(plugin.toLowerCase())
    ? path.join(baseDataDir, plugin)
    : path.join(o.clientModsDir, plugin));

  const copies = [];
  for (const plugin of manifest.plugins) {
    const src = sourceOf(plugin);
    const dst = path.join(dataDir, plugin);
    if (!fs.existsSync(dst) || sha256File(dst) !== sha256File(src)) copies.push({ src, dst, plugin });
  }

  log(`[client-mods] server load order: ${serverLoadOrder.join(', ')}`);
  if (manifest.lightPlugins && manifest.lightPlugins.length > 0) {
    if (lightSupported) {
      log(`[client-mods] light (ESL) plugins, loaded in game order by the patched server: ${manifest.lightPlugins.join(', ')}`);
    } else {
      log(`[client-mods] WARNING light (ESL) plugins, unsupported by stock SkyMP: ${manifest.lightPlugins.join(', ')}. ` +
        'They are last on the server so every other plugin keeps its index; records defined in them will not match between server and game.');
    }
  }
  for (const c of copies) log(`[client-mods] copy to server data: ${c.plugin}`);
  for (const r of removed) log(`[client-mods] remove from server (no longer needed): ${r}`);

  // ── mods.json (launcher parity) ──────────────────────────────────────────
  const hashFor = (plugin) => {
    const copy = copies.find(c => c.plugin.toLowerCase() === plugin.toLowerCase());
    return sha256File(copy ? copy.src : path.join(dataDir, plugin));
  };
  const modsJson = {
    generatedAt: new Date().toISOString(),
    hashAlgorithm: 'sha256',
    sourceDataDir: dataDir,
    loadOrderSource: 'game load order from skymp/client-mods (sync-client-mods.js); server index order is in server-settings.json',
    mods: clientLoadOrder.map(filename => ({ filename, hash: hashFor(filename) })),
    loadOrder: clientLoadOrder
  };

  const loadOrderChanged = JSON.stringify(settings.loadOrder) !== JSON.stringify(serverLoadOrder);
  let modsChanged = true;
  if (fs.existsSync(o.modsJsonPath)) {
    try {
      const old = readJson(o.modsJsonPath);
      modsChanged = JSON.stringify(old.loadOrder) !== JSON.stringify(modsJson.loadOrder) ||
        JSON.stringify(old.mods) !== JSON.stringify(modsJson.mods);
    } catch { modsChanged = true; }
  }

  const summary = {
    manifest, loadOrder: serverLoadOrder, clientLoadOrder, copies: copies.map(c => c.plugin), removed,
    loadOrderChanged, modsChanged
  };
  if (check) return summary;

  for (const c of copies) fs.copyFileSync(c.src, c.dst);
  for (const r of removed) {
    const victim = fs.readdirSync(dataDir).find(n => n.toLowerCase() === r);
    if (victim) {
      const backup = path.join(dataDir, `${victim}.removed-${stamp()}`);
      fs.renameSync(path.join(dataDir, victim), backup);
      log(`  moved aside: ${path.basename(backup)}`);
    }
  }
  if (loadOrderChanged) {
    backupAndWrite(o.serverSettingsPath, `${JSON.stringify({ ...settings, loadOrder: serverLoadOrder }, null, 2)}\n`, log);
  }
  if (modsChanged) {
    backupAndWrite(o.modsJsonPath, `${JSON.stringify(modsJson, null, 2)}\n`, log);
  }
  backupAndWrite(o.manifestOutPath, `${JSON.stringify(manifest, null, 2)}\n`, () => {});
  log('[client-mods] done.');
  return summary;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  syncClientMods({ check, log: (s) => console.log(s) })
    .then((s) => {
      if (check) console.log(`[client-mods] --check: nothing written (load order ${s.loadOrderChanged ? 'WOULD change' : 'unchanged'}).`);
    })
    .catch((err) => {
      console.error(`[client-mods] FAILED: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { syncClientMods };
