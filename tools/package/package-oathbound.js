#!/usr/bin/env node
/**
 * Builds the two archives for moving OATHBOUND to a Windows Server VPS.
 *
 *   node tools/package/package-oathbound.js server     → OATHBOUND-Server-<date>.zip
 *   node tools/package/package-oathbound.js launcher   → OATHBOUND-Launcher-Source-<date>.zip
 *   node tools/package/package-oathbound.js both
 *
 * Options: --out <dir> (default E:\SkyrimRP\share), --no-db (skip the database dump).
 *
 * The server archive is everything the VPS runs: the patched SkyMP server,
 * the plugins it loads, the saved world (players, placed holdstones), the
 * gamemode, the panel / game API / Discord bot with their node_modules and
 * .env files, the player mods the launcher downloads, the start scripts, a
 * dump of the database, and VPS-SETUP.md. Backups, logs and old copies are
 * left out. **It contains secrets** (.env files, database password, SkyMP
 * master key, Discord app secret): share it privately, never by public link.
 *
 * The launcher archive is the launcher's source with its .env: the server
 * address is built into the launcher, so it is rebuilt once the VPS address
 * is set (apps/launcher/.env → npm ci → npm run build).
 *
 * Stop the game server first, so the world save is not caught mid-write.
 * Uses Windows' tar.exe (bsdtar), which writes zip files; files are stored
 * uncompressed (the mods are mostly compressed archives already).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const what = args[0];
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'E:\\SkyrimRP\\share';
/**
 * --fresh: a new server with an empty database. Leaves out the database dump
 * AND the saved world (skymp/world): SkyMP keys each player's body (position,
 * inventory, gold) by account number, so an old world on a new database hands
 * the first new accounts somebody else's character.
 */
const FRESH = args.includes('--fresh');
const WITH_DB = !args.includes('--no-db') && !FRESH;
/** --public-host <ip or name>: the VPS address, written into the packaged apps/web/.env. */
const PUBLIC_HOST = args.includes('--public-host') ? args[args.indexOf('--public-host') + 1] : null;
const BSDTAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** Never packaged, anywhere: backups, old copies, logs, editor junk. */
const EXCLUDE_EVERYWHERE = [
  '*.bak', '*.bak-*', '*.bak.*', '*.before-*', '*.removed-*', '*.pre-phase0-*',
  '*.pdb', '*.log', '.DS_Store', 'Thumbs.db', '.git'
];

const SERVER_PATHS = [
  'skymp/server', 'skymp/data', 'skymp/world', 'skymp/gamemode', 'skymp/ui',
  'skymp/packages', 'skymp/client-mods',
  'apps/web', 'apps/game-api', 'apps/bot-discord', 'apps/shared',
  'scripts', 'patches/manifest.json'
].filter((p) => !(FRESH && p === 'skymp/world'));
const SERVER_EXCLUDE = [
  'skymp/server/logs',
  'apps/web/crash-reports', 'apps/game-api/client-mods-hash-cache.json'
];

// skymp/ui: electron-builder bundles it into the installer (extraResources).
const LAUNCHER_PATHS = ['apps/launcher', 'apps/shared', 'skymp/ui'];
const LAUNCHER_EXCLUDE = [
  'apps/launcher/node_modules', 'apps/launcher/dist', 'apps/launcher/dist-electron', 'apps/launcher/release',
  'apps/launcher/src.before-english', 'apps/launcher/src.before-oathbound-branding'
];

function log(s) { console.log(s); }

function gameServerRunning() {
  try {
    return /:7777\s/.test(execFileSync('netstat', ['-ano', '-p', 'UDP'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

function dumpDatabase(stage) {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'skymp', 'config', 'database.local.json'), 'utf8'));
  const candidates = [
    process.env.MARIADB_DUMP,
    ...fs.readdirSync('C:\\Program Files').filter((d) => /^MariaDB/i.test(d))
      .map((d) => path.join('C:\\Program Files', d, 'bin', 'mariadb-dump.exe'))
  ].filter(Boolean);
  const dumpExe = candidates.find((p) => fs.existsSync(p));
  if (!dumpExe) throw new Error('mariadb-dump.exe not found (set MARIADB_DUMP)');
  const outFile = path.join(stage, 'database', `${cfg.database}.sql`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const r = spawnSync(dumpExe, [
    `--host=${cfg.host}`, `--port=${cfg.port}`, `--user=${cfg.user}`,
    '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob',
    '--default-character-set=utf8mb4', '--databases', cfg.database, `--result-file=${outFile}`
  ], { env: { ...process.env, MYSQL_PWD: cfg.password }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`database dump failed: ${r.stderr || r.error}`);
  log(`database dump: ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB`);
}

/**
 * skymp/config without client-mods.local.json, listed file by file: the VPS
 * gets its own copy from the stage, and a --exclude would drop that one too
 * (tar matches excludes against every source).
 */
function configFiles() {
  const dir = path.join(REPO, 'skymp', 'config');
  return fs.readdirSync(dir)
    .filter((n) => n !== 'client-mods.local.json' && fs.statSync(path.join(dir, n)).isFile())
    .filter((n) => !/\.(bak|before-|removed-)/i.test(n))
    .map((n) => `skymp/config/${n}`);
}

/** A folder's top-level entries except `skip` (same reason as configFiles). */
function listWithout(dirRel, skip) {
  return fs.readdirSync(path.join(REPO, dirRel)).filter((n) => !skip.includes(n)).map((n) => `${dirRel}/${n}`);
}

/** Server paths, with apps/web listed entry by entry when its .env is replaced. */
function serverPaths() {
  const paths = [...SERVER_PATHS, ...configFiles()];
  if (!PUBLIC_HOST) return paths;
  return paths.flatMap((p) => (p === 'apps/web' ? listWithout('apps/web', ['.env']) : [p]));
}

/** apps/web/.env with the panel's public address and Discord callback set to the VPS. */
function stageWebEnv(stage) {
  const src = fs.readFileSync(path.join(REPO, 'apps', 'web', '.env'), 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const url = `http://${PUBLIC_HOST}:3001`;
  let callbackWritten = false;
  const lines = src.split(/\r?\n/).flatMap((line) => {
    if (/^PANEL_PUBLIC_URL=/.test(line)) return [`PANEL_PUBLIC_URL=${url}`];
    if (/^DISCORD_CALLBACK_URL=/.test(line)) {
      if (callbackWritten) return [];
      callbackWritten = true;
      return [`DISCORD_CALLBACK_URL=${url}/api/auth/discord/callback`];
    }
    return [line];
  });
  const out = path.join(stage, 'apps', 'web', '.env');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join(nl));
  log(`apps/web/.env: panel and Discord callback set to ${url}`);
}

function stageServerExtras(stage) {
  // The base-game masters the mods need are already in skymp/data on the VPS.
  const cfgPath = path.join(REPO, 'skymp', 'config', 'client-mods.local.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.baseGameDataDir = 'skymp/data';
  const out = path.join(stage, 'skymp', 'config', 'client-mods.local.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
  fs.copyFileSync(path.join(__dirname, 'VPS-SETUP.md'), path.join(stage, 'VPS-SETUP.md'));
  if (WITH_DB) dumpDatabase(stage);
  // An empty world folder: SkyMP starts a new world in it.
  if (FRESH) fs.mkdirSync(path.join(stage, 'skymp', 'world'), { recursive: true });
  if (PUBLIC_HOST) stageWebEnv(stage);
}

function stageLauncherExtras(stage) {
  fs.copyFileSync(path.join(__dirname, 'LAUNCHER-BUILD.md'), path.join(stage, 'LAUNCHER-BUILD.md'));
}

function zip(name, paths, exclude, stage) {
  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, `${name}-${STAMP}.zip`);
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const missing = paths.filter((p) => !fs.existsSync(path.join(REPO, p)));
  const present = paths.filter((p) => !missing.includes(p));
  if (missing.length) log(`(not present, skipped: ${missing.join(', ')})`);
  // No top folder inside the zip (Windows' bsdtar has no -s): "Extract All"
  // makes one named after the zip.
  const tarArgs = ['-a', '-c', '-f', outFile, '--options', 'zip:compression=store'];
  for (const e of [...EXCLUDE_EVERYWHERE, ...exclude]) tarArgs.push('--exclude', e);
  tarArgs.push('-C', REPO, ...present);
  const extras = fs.readdirSync(stage);
  if (extras.length) tarArgs.push('-C', stage, ...extras);
  log(`writing ${outFile} …`);
  const r = spawnSync(BSDTAR, tarArgs, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`tar failed (${r.status}): ${r.stderr}`);
  log(`done: ${(fs.statSync(outFile).size / 1073741824).toFixed(2)} GB`);
  return outFile;
}

function main() {
  if (!['server', 'launcher', 'both'].includes(what)) {
    console.error('usage: node tools/package/package-oathbound.js server|launcher|both [--out dir] [--no-db] [--fresh] [--public-host <ip>]');
    process.exit(2);
  }
  if (!fs.existsSync(BSDTAR)) throw new Error(`${BSDTAR} not found`);
  if ((what === 'server' || what === 'both') && gameServerRunning()) {
    log('WARNING: the game server is running (UDP 7777). Stop it first so the world save is consistent.');
    if (!args.includes('--allow-running')) process.exit(1);
  }
  const made = [];
  if (what === 'server' || what === 'both') {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oathbound-server-'));
    stageServerExtras(stage);
    made.push(zip('OATHBOUND-Server', serverPaths(), SERVER_EXCLUDE, stage));
    fs.rmSync(stage, { recursive: true, force: true });
  }
  if (what === 'launcher' || what === 'both') {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oathbound-launcher-'));
    stageLauncherExtras(stage);
    made.push(zip('OATHBOUND-Launcher-Source', LAUNCHER_PATHS, LAUNCHER_EXCLUDE, stage));
    fs.rmSync(stage, { recursive: true, force: true });
  }
  log(`\n${made.join('\n')}\nThe server archive contains secrets: share it privately.`);
}

main();
