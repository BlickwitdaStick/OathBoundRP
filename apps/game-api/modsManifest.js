/**
 * modsManifest.js
 *
 * Loads and serves the modpack parity manifest (`mods.json`).
 *
 * This is the file that backs the FormID contract described in
 * `docs/technical/MODS_AND_GAMEMODE_CONTRACT.md`: the launcher compares the hash
 * of each file in `Data/` against this list, and validates the plugin order
 * against `loadOrder`. Unless both match, the same `base_id` in the database can
 * mean different items on each player's screen.
 *
 * The manifest is generated offline by `scripts/generate-mods-manifest.js` from
 * the server's `Data/` folder. Here we only read and serve it — on purpose:
 * hashing on demand inside an HTTP request would be slow and could serve an
 * inconsistent manifest while someone is copying files into the folder.
 */

const fs = require('fs');

function isValidManifest(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.hashAlgorithm !== 'sha256') return false;
  if (!Array.isArray(data.mods) || data.mods.length === 0) return false;
  if (!Array.isArray(data.loadOrder) || data.loadOrder.length === 0) return false;
  return data.mods.every((mod) =>
    mod && typeof mod.filename === 'string' && mod.filename.length > 0 &&
    typeof mod.hash === 'string' && /^[a-f0-9]{64}$/i.test(mod.hash)
  );
}

/**
 * Reads the manifest from disk, with a cache invalidated by mtime.
 *
 * Returns `{ ok: false, reason }` instead of throwing or returning an empty
 * manifest: a missing or corrupt manifest has to become a visible error for the
 * launcher, not an empty list — an empty list would pass the parity check and
 * let any modpack in, which is exactly the opposite of what this file exists
 * to prevent.
 */
function createManifestLoader(manifestPath) {
  let cached = null;
  let cachedMtimeMs = null;

  function load() {
    let stat;
    try {
      stat = fs.statSync(manifestPath);
    } catch {
      return { ok: false, reason: 'manifest_missing' };
    }

    if (cached && cachedMtimeMs === stat.mtimeMs) {
      return { ok: true, manifest: cached };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { ok: false, reason: 'manifest_invalid_json' };
    }

    if (!isValidManifest(parsed)) {
      return { ok: false, reason: 'manifest_invalid_shape' };
    }

    cached = parsed;
    cachedMtimeMs = stat.mtimeMs;
    return { ok: true, manifest: parsed };
  }

  return { load };
}

module.exports = { createManifestLoader, isValidManifest };
