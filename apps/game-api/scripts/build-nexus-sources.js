#!/usr/bin/env node
/**
 * build-nexus-sources.js
 *
 * Builds skymp/config/nexus-sources.json: for each Nexus file listed in
 * skymp/config/nexus-sources.input.json, which of its files are hosted in
 * skymp/client-mods (same size + SHA-256), and under which path.
 *
 * Runs on the owner's PC, where the original archives / unpacked copies are.
 * Reads the manifest sync-client-mods.js wrote (client-mods-manifest.json), so
 * run that first after changing client-mods. File names, versions and sizes
 * come from the public Nexus GraphQL API (no key needed).
 *
 * The launcher matches archive entries by path suffix or name + size and
 * checks every SHA-256 before installing, so a wrong guess here only costs a
 * wasted download — the file then comes from the game server.
 *
 * Usage:
 *   node scripts/build-nexus-sources.js [--root E:/SkyrimRP]
 *   SEVEN_ZIP=path/to/7za.exe overrides the 7-Zip used to open archives.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GAME_API_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(GAME_API_DIR, '..', '..');
const INPUT = path.join(REPO_DIR, 'skymp', 'config', 'nexus-sources.input.json');
const OUTPUT = path.join(REPO_DIR, 'skymp', 'config', 'nexus-sources.json');
const MANIFEST = process.env.CLIENT_MODS_MANIFEST_PATH || path.join(GAME_API_DIR, 'client-mods-manifest.json');
const SEVEN_ZIP = process.env.SEVEN_ZIP ||
  path.join(REPO_DIR, 'apps', 'launcher', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveLocal(root, local) {
  if (local.startsWith('~/')) return path.join(os.homedir(), local.slice(2));
  return path.isAbsolute(local) ? local : path.join(root, local);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function sha256File(p) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

async function nexusFiles(gameId, modId) {
  const body = { query: `{ modFiles(modId: ${modId}, gameId: ${gameId}) { fileId name version sizeInBytes uri category } }` };
  const res = await fetch('https://api.nexusmods.com/v2/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Nexus GraphQL HTTP ${res.status} for mod ${modId}`);
  const j = await res.json();
  if (j.errors) throw new Error(`Nexus GraphQL error for mod ${modId}: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data.modFiles || [];
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'file';
}

async function main() {
  const root = arg('--root', 'E:/SkyrimRP');
  const input = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const bySize = new Map();
  for (const f of manifest.files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const assigned = new Set();
  const sources = [];
  // The previous recipe: a mod whose local archive is gone keeps its entry as
  // long as the Nexus file is the same and its files are still in the manifest
  // (archives get moved or deleted after install; Nexus still has them).
  let previous = [];
  try { previous = (JSON.parse(fs.readFileSync(OUTPUT, 'utf8')).sources) || []; } catch { previous = []; }
  const byPath = new Map(manifest.files.map(f => [f.path, f]));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sources-'));

  try {
    for (const s of input.sources) {
      const files = await nexusFiles(input.gameId, s.modId);
      const nf = files.find(f => f.fileId === s.fileId);
      if (!nf) { console.log(`SKIP ${s.id}: file ${s.fileId} not on Nexus mod ${s.modId}`); continue; }
      if (nf.category === 'REMOVED' || nf.category === 'DELETED') { console.log(`SKIP ${s.id}: Nexus file is ${nf.category}`); continue; }

      const local = resolveLocal(root, s.local);
      if (!fs.existsSync(local)) {
        const old = previous.find(p => p.id === s.id && p.modId === s.modId && p.fileId === s.fileId);
        const kept = old ? old.provides.filter(p => byPath.has(p.path) && byPath.get(p.path).sha256 === p.sha256 && !assigned.has(p.path)) : [];
        if (kept.length === 0) { console.log(`SKIP ${s.id}: local copy not found (${local})`); continue; }
        for (const p of kept) assigned.add(p.path);
        sources.push({ ...old, provides: kept });
        console.log(`KEPT ${s.id}: local copy gone; ${kept.length} file(s) from the previous recipe`);
        continue;
      }
      let contentDir = local;
      let localArchiveSize = 0;
      if (fs.statSync(local).isFile()) {
        if (/\.rar$/i.test(local)) { console.log(`SKIP ${s.id}: RAR archives are not supported by the launcher`); continue; }
        localArchiveSize = fs.statSync(local).size;
        contentDir = path.join(tmpRoot, s.id);
        execFileSync(SEVEN_ZIP, ['x', local, `-o${contentDir}`, '-y', '-bd'], { stdio: 'ignore' });
      }

      const provides = [];
      for (const p of walk(contentDir)) {
        const size = fs.statSync(p).size;
        const candidates = (bySize.get(size) || []).filter(c => !assigned.has(c.path));
        if (candidates.length === 0) continue;
        const sha = sha256File(p);
        const src = path.relative(contentDir, p).split(path.sep).join('/');
        for (const c of candidates) {
          if (c.sha256 !== sha) continue;
          provides.push({ src, path: c.path, sha256: c.sha256 });
          assigned.add(c.path);
        }
      }
      if (contentDir !== local) fs.rmSync(contentDir, { recursive: true, force: true });

      const nexusSize = Number(nf.sizeInBytes) || 0;
      if (localArchiveSize && nexusSize && localArchiveSize !== nexusSize) {
        console.log(`WARN ${s.id}: local archive is ${localArchiveSize} bytes, Nexus file is ${nexusSize}`);
      }
      const uriIsName = nf.uri && !nf.uri.includes('/');
      const ext = path.extname(uriIsName ? nf.uri : local) || '.7z';
      const entry = {
        id: s.id,
        name: String(nf.name).replace(/\s+/g, ' ').trim(),
        modId: s.modId,
        fileId: s.fileId,
        version: nf.version || '',
        fileName: uriIsName ? safeName(nf.uri) : `${safeName(nf.name)}-${s.modId}-${s.fileId}${ext}`,
        size: nexusSize || localArchiveSize,
        provides
      };
      const bytes = provides.reduce((sum, p) => sum + (manifest.files.find(f => f.path === p.path)?.size || 0), 0);
      console.log(`${provides.length ? 'OK  ' : 'NONE'} ${s.id}: ${provides.length} file(s), ${(bytes / 1048576).toFixed(1)} MB from a ${(entry.size / 1048576).toFixed(1)} MB archive`);
      if (provides.length > 0) sources.push(entry);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const coveredBytes = manifest.files.filter(f => assigned.has(f.path)).reduce((s, f) => s + f.size, 0);
  const out = {
    '//': 'Generated by apps/game-api/scripts/build-nexus-sources.js from nexus-sources.input.json. Do not edit by hand.',
    generatedAt: new Date().toISOString(),
    game: input.game,
    manifestVersion: manifest.version,
    sources
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\n${sources.length} Nexus source(s) cover ${assigned.size}/${manifest.files.length} file(s), ` +
    `${(coveredBytes / 1073741824).toFixed(2)} of ${(manifest.totalBytes / 1073741824).toFixed(2)} GB. Wrote ${OUTPUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
