'use strict';

/**
 * Nexus Mods sources for the hosted client mods.
 *
 * skymp/config/nexus-sources.json (built by scripts/build-nexus-sources.js)
 * says which Nexus file contains which client-mods file. The launcher
 * downloads those archives from Nexus, extracts just the listed files and
 * checks each one's SHA-256 against the manifest; whatever Nexus cannot
 * provide (OATHBOUND's own files, patched or merged files, RAR-only mods)
 * still comes from /client-mods/files on this server.
 *
 * At sync time each entry is checked against the freshly built manifest: an
 * entry whose file changed or left client-mods is dropped, so a stale recipe
 * never makes players download an archive that no longer matches.
 */

const fs = require('fs');
const { isSafeRelativePath } = require('./clientMods');

function isSafeArchivePath(src) {
  // Archive-internal path: same rules as a Data path.
  return isSafeRelativePath(src);
}

/**
 * @param {object} recipe parsed nexus-sources.json
 * @param {{files:{path:string,size:number,sha256:string}[]}} manifest
 * @returns {{sources:object[], dropped:string[]}}
 */
function attachNexusSources(recipe, manifest) {
  const dropped = [];
  if (!recipe || !Array.isArray(recipe.sources)) return { sources: [], dropped };
  const byPath = new Map(manifest.files.map(f => [f.path, f]));
  const sources = [];
  for (const s of recipe.sources) {
    const label = (s && (s.id || s.name)) || '?';
    if (!s || !Number.isInteger(s.modId) || s.modId <= 0 || !Number.isInteger(s.fileId) || s.fileId <= 0 ||
        typeof s.fileName !== 'string' || s.fileName.includes('/') || !isSafeRelativePath(s.fileName) ||
        // size 0 = Nexus does not report it
        !Number.isInteger(s.size) || s.size < 0 || !Array.isArray(s.provides)) {
      dropped.push(`${label}: invalid entry`);
      continue;
    }
    const provides = [];
    let stale = 0;
    for (const p of s.provides) {
      const f = p && byPath.get(p.path);
      if (!f || !isSafeArchivePath(p.src) || f.sha256 !== p.sha256) { stale++; continue; }
      provides.push({ src: p.src, path: p.path });
    }
    if (stale > 0) dropped.push(`${label}: ${stale} file(s) no longer match client-mods`);
    if (provides.length === 0) continue;
    sources.push({
      id: String(s.id || s.modId),
      name: String(s.name || s.id),
      game: recipe.game || 'skyrimspecialedition',
      modId: s.modId,
      fileId: s.fileId,
      version: s.version ? String(s.version) : '',
      fileName: s.fileName,
      size: s.size,
      provides
    });
  }
  return { sources, dropped };
}

function readNexusRecipe(recipePath) {
  try { return JSON.parse(fs.readFileSync(recipePath, 'utf8')); } catch { return null; }
}

module.exports = { attachNexusSources, readNexusRecipe };
