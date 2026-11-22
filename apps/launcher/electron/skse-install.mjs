/**
 * SKSE64 for players who do not have it.
 *
 * SKSE may only be downloaded from its authors (skse.silverlock.org, their
 * GitHub, or their own Nexus page): the OATHBOUND server must not host it. So
 * the launcher downloads the exact official 2.2.6 archive itself, checks it
 * against a pinned SHA-256, and installs what a player would copy by hand:
 * skse64_loader.exe + skse64_1_6_1170.dll next to SkyrimSE.exe, and
 * Data/Scripts/*.pex (SKSE's script extensions) into Data/Scripts.
 *
 * It also tells apart the one Skyrim build this SKSE works with (1.6.1170):
 * any other SkyrimSE.exe would start without SKSE and never reach the server.
 *
 * Pure Node (no Electron) so it can be unit-tested; main.ts wires it to IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const SKSE = Object.freeze({
  version: '2.2.6',
  url: 'https://skse.silverlock.org/beta/skse64_2_02_06.7z',
  archiveSha256: 'd7297f1a1d613e5265e1af4dbbfe8bd37a32719c1ccef363fc6187fa6eba0848',
  archiveSize: 751136,
  folder: 'skse64_2_02_06',
  rootFiles: Object.freeze({
    'skse64_loader.exe': '730c2743f6871fbaeb8606c1d3b7a55feca045c3d74858a41b0c6d03cd989fbc',
    'skse64_1_6_1170.dll': 'c9a2c8a80df6bf2372c5f49468bb2e5ab67786157265b6f29ece9f4eac075d54'
  })
});

/** SkyrimSE.exe of Skyrim AE 1.6.1170 (Steam), the build SKSE 2.2.6 supports. */
export const SKYRIM_1170_SHA256 = 'c434208894f07f604b852f29b8edc3a58c4de63de783373733e72b2b73f33be9';

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * @returns {Promise<{installed:boolean, missing:string[], skyrimVersionOk:boolean|null}>}
 * skyrimVersionOk is null when SkyrimSE.exe cannot be read.
 */
export async function checkSkse(gamePath, { hash = sha256File } = {}) {
  const missing = [];
  for (const [name, sha] of Object.entries(SKSE.rootFiles)) {
    const full = path.join(gamePath, name);
    let ok = false;
    try { ok = fs.statSync(full).isFile() && (await hash(full)) === sha; } catch { ok = false; }
    if (!ok) missing.push(name);
  }
  if (!fs.existsSync(path.join(gamePath, 'Data', 'Scripts', 'skse.pex'))) missing.push('Data/Scripts/skse.pex');
  let skyrimVersionOk = null;
  try { skyrimVersionOk = (await hash(path.join(gamePath, 'SkyrimSE.exe'))) === SKYRIM_1170_SHA256; } catch { skyrimVersionOk = null; }
  return { installed: missing.length === 0, missing, skyrimVersionOk };
}

function run7z(sevenZipPath, args) {
  return new Promise((resolve, reject) => {
    execFile(sevenZipPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`7-Zip failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Downloads the official archive to `dest` and verifies it. */
export async function downloadSkse({ dest, fetchImpl = fetch, onProgress }) {
  const res = await fetchImpl(SKSE.url, { headers: { 'User-Agent': 'OATHBOUND-Launcher' } });
  if (!res.ok || !res.body) throw new Error(`Could not download SKSE from skse.silverlock.org (${res.status}).`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ done, total: SKSE.archiveSize });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const sha = await sha256File(tmp);
  if (sha !== SKSE.archiveSha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The SKSE download did not match the official 2.2.6 archive. Try again later.');
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Installs SKSE 2.2.6 into `gamePath`. Idempotent; overwrites only SKSE's own
 * files. @returns {Promise<{installed:string[]}>}
 */
export async function installSkse({ gamePath, sevenZipPath, workDir, fetchImpl, onProgress }) {
  fs.mkdirSync(workDir, { recursive: true });
  const archive = path.join(workDir, `${SKSE.folder}.7z`);
  let haveArchive = false;
  try { haveArchive = (await sha256File(archive)) === SKSE.archiveSha256; } catch { haveArchive = false; }
  if (!haveArchive) await downloadSkse({ dest: archive, fetchImpl, onProgress });

  const outDir = path.join(workDir, `extract-${Date.now()}`);
  await run7z(sevenZipPath, ['x', archive, `-o${outDir}`, '-y', '-bd',
    `${SKSE.folder}\\skse64_loader.exe`, `${SKSE.folder}\\skse64_1_6_1170.dll`, `${SKSE.folder}\\Data\\Scripts\\*.pex`]);

  const installed = [];
  const src = path.join(outDir, SKSE.folder);
  for (const [name, sha] of Object.entries(SKSE.rootFiles)) {
    const from = path.join(src, name);
    if ((await sha256File(from)) !== sha) throw new Error(`SKSE file ${name} did not match the official build.`);
    fs.copyFileSync(from, path.join(gamePath, name));
    installed.push(name);
  }
  const scriptsFrom = path.join(src, 'Data', 'Scripts');
  const scriptsTo = path.join(gamePath, 'Data', 'Scripts');
  fs.mkdirSync(scriptsTo, { recursive: true });
  for (const name of fs.readdirSync(scriptsFrom)) {
    if (!/\.pex$/i.test(name)) continue;
    fs.copyFileSync(path.join(scriptsFrom, name), path.join(scriptsTo, name));
    installed.push(`Data/Scripts/${name}`);
  }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* temp folder; best effort */ }
  return { installed };
}
