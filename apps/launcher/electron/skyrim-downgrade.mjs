/**
 * Downgrade a Steam Skyrim AE install to 1.6.1170, the build SKSE 2.2.6 and
 * the server use.
 *
 * Bethesda's files can only come from Steam, with the player's own copy. The
 * launcher uses DepotDownloader (SteamRE, GPL-2.0), fetched on demand from its
 * official GitHub release and checked against a pinned SHA-256. It runs in its
 * own console window: the player types their Steam password and Steam Guard
 * code there (or approves in the Steam app). The launcher never sees them.
 *
 * DepotDownloader writes straight into the game folder with -validate, so it
 * only downloads the parts of files that differ from 1.6.1170. SkyrimSE.exe
 * and the five masters are backed up first.
 *
 * Pure Node (no Electron) so it can be unit-tested; main.ts wires it to IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

export const DEPOT_DOWNLOADER = Object.freeze({
  version: '3.4.0',
  url: 'https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-windows-x64.zip',
  zipSha256: '41c9e9f0df54b3ad02e67a11726756e5c73283bd7c2e1b04acfa5ae4c2ed3767',
  zipSize: 33474005
});

/** Steam app 489830 (Skyrim SE/AE) at 1.6.1170 (Nexus "Steam Manifest List", article 6536). */
export const SKYRIM_1170 = Object.freeze({
  app: 489830,
  depots: Object.freeze([
    [489831, '8442952117333549665'],
    [489832, '8042843504692938467'],
    [489833, '1914580699073641964']
  ])
});

const BACKUP_FILES = ['SkyrimSE.exe', 'Data/Skyrim.esm', 'Data/Update.esm', 'Data/Dawnguard.esm', 'Data/HearthFires.esm', 'Data/Dragonborn.esm'];

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Steam account names: letters, digits and underscores (Steam's own rule). */
export function isValidSteamUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(name);
}

/** DepotDownloader's arguments: all three depots in one run, so one login. */
export function downgradeArgs({ gamePath, username }) {
  if (!isValidSteamUsername(username)) throw new Error('That does not look like a Steam account name.');
  return [
    '-app', String(SKYRIM_1170.app),
    '-depot', ...SKYRIM_1170.depots.map(([d]) => String(d)),
    '-manifest', ...SKYRIM_1170.depots.map(([, m]) => m),
    '-username', username,
    '-os', 'windows', '-osarch', '64',
    '-dir', gamePath,
    '-validate'
  ];
}

/** Downloads + unpacks DepotDownloader once (verified); returns the exe path. */
export async function ensureDepotDownloader({ toolDir, sevenZipPath, fetchImpl = fetch, onProgress }) {
  const exe = path.join(toolDir, 'DepotDownloader.exe');
  const stamp = path.join(toolDir, 'version.txt');
  try { if (fs.existsSync(exe) && fs.readFileSync(stamp, 'utf8').trim() === DEPOT_DOWNLOADER.version) return exe; } catch { /* reinstall */ }
  fs.mkdirSync(toolDir, { recursive: true });
  const zip = path.join(toolDir, 'DepotDownloader.zip');
  const res = await fetchImpl(DEPOT_DOWNLOADER.url, { headers: { 'User-Agent': 'OATHBOUND-Launcher' } });
  if (!res.ok || !res.body) throw new Error(`Could not download DepotDownloader (${res.status}).`);
  const out = fs.createWriteStream(`${zip}.part`);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ done, total: DEPOT_DOWNLOADER.zipSize });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if ((await sha256File(`${zip}.part`)) !== DEPOT_DOWNLOADER.zipSha256) {
    fs.rmSync(`${zip}.part`, { force: true });
    throw new Error('The DepotDownloader download did not match the official 3.4.0 release.');
  }
  fs.renameSync(`${zip}.part`, zip);
  await new Promise((resolve, reject) => execFile(sevenZipPath, ['x', zip, `-o${toolDir}`, '-y', '-bd'], { windowsHide: true },
    (err) => (err ? reject(new Error(`Could not unpack DepotDownloader: ${err.message}`)) : resolve())));
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(stamp, DEPOT_DOWNLOADER.version);
  return exe;
}

/** Copies SkyrimSE.exe and the masters aside once, before anything changes. */
export function backupGameFiles(gamePath) {
  const dir = path.join(gamePath, 'OATHBOUND_downgrade_backup');
  const saved = [];
  for (const rel of BACKUP_FILES) {
    const from = path.join(gamePath, ...rel.split('/'));
    const to = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    saved.push(rel);
  }
  return { dir, saved };
}

/**
 * Runs DepotDownloader in a console window of its own and waits for it.
 * @returns {Promise<number>} exit code
 */
export function runDepotDownloader({ exe, args, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    // detached on Windows = a new console window the player can type into.
    const child = spawnImpl(exe, args, { detached: true, windowsHide: false, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });
}
