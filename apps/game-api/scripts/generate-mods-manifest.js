#!/usr/bin/env node
/**
 * generate-mods-manifest.js
 *
 * Generates the `mods.json` the launcher uses to check modpack parity, from the
 * server's reference `Data/` folder.
 *
 * Usage:
 *   node scripts/generate-mods-manifest.js "D:\\Skyrim Special Edition\\Data"
 *   node scripts/generate-mods-manifest.js <Data> --out ./mods.json --plugins-txt <plugins.txt>
 *
 * The manifest declares SHA-256 and the launcher rejects any other algorithm.
 * Beyond detecting corruption, the hash is part of the parity gate against
 * deliberate tampering with the distributed files; that is why MD5 is not
 * accepted.
 *
 * The order in `loadOrder` matters far more than the contents of `mods`: it is
 * what fixes the load-order index embedded in every FormID.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_EXTENSIONS = ['.esm', '.esp', '.esl'];
// Extensions worth checking by hash. We don't include everything: a Data folder
// has thousands of loose files, and checking texture by texture would make the
// launcher boot unbearable for no gain — a texture mismatch neither shifts
// FormIDs nor breaks sync.
const HASHED_EXTENSIONS = [...PLUGIN_EXTENSIONS, '.bsa', '.bsl'];

function parseArgs(argv) {
  const args = { dataDir: null, out: null, pluginsTxt: null, onlyLoadOrder: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { args.out = argv[++i]; continue; }
    if (argv[i] === '--plugins-txt') { args.pluginsTxt = argv[++i]; continue; }
    if (argv[i] === '--only-load-order') { args.onlyLoadOrder = true; continue; }
    rest.push(argv[i]);
  }
  args.dataDir = rest[0] || null;
  return args;
}

// SHA-256 since 2026-08-23. It used to be MD5, and MD5 has practical
// collisions: the threat model here is not accidental corruption but a player
// deliberately altering a mod -- the only case where collisions matter. The
// algorithm is DECLARED in the manifest so that an old mods.json fails by
// telling the truth instead of flagging every mod as corrupt.
const HASH_ALGORITHM = 'sha256';

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(HASH_ALGORITHM);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Reads the plugin order from a Skyrim `plugins.txt` (mod-manager format: one
 * line per plugin, `*` prefixing the active ones).
 *
 * We prefer this source when available because the directory's alphabetical
 * order is NOT the real load order — and using the wrong order here would
 * produce a manifest that rejects everyone, or worse, one that approves a
 * diverging order.
 */
function readPluginsTxt(pluginsTxtPath) {
  const lines = fs.readFileSync(pluginsTxtPath, 'utf8').split(/\r?\n/);
  const order = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const enabled = trimmed.startsWith('*');
    const name = enabled ? trimmed.slice(1).trim() : trimmed;
    if (!name) continue;
    if (!PLUGIN_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    if (enabled) order.push(name);
  }
  return order;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dataDir) {
    console.error('Usage: node scripts/generate-mods-manifest.js <path-to-Data> [--out mods.json] [--plugins-txt plugins.txt] [--only-load-order]');
    process.exit(1);
  }

  const dataDir = path.resolve(args.dataDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    console.error(`[manifest] Data folder not found: ${dataDir}`);
    process.exit(1);
  }

  const outPath = path.resolve(args.out || path.join(__dirname, '..', 'mods.json'));

  // Full listing of Data. It remains the source for validating the load order
  // even when what gets hashed is a subset.
  const allFiles = fs.readdirSync(dataDir)
    .filter((name) => HASHED_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .filter((name) => {
      try { return fs.statSync(path.join(dataDir, name)).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  if (allFiles.length === 0) {
    console.error(`[manifest] No plugin or BSA found in ${dataDir}. Wrong path?`);
    process.exit(1);
  }

  // `--only-load-order`: hashes ONLY the load-order plugins, ignoring the rest
  // of Data.
  //
  // It exists because `compareMods` (apps/launcher/electron/parity.mjs)
  // requires EVERY file in the manifest to exist on the client with the same
  // hash. Generating from a working Data folder, with dozens of mods installed,
  // produces a manifest that says "have exactly my machine" — and rejects any
  // tester with a clean install, with a "Missing mod" about a mod that is not
  // part of anything.
  //
  // Until the official modpack exists, what has to be identical across clients
  // is the LOAD ORDER, because that is where the index embedded in every FormID
  // comes from (MODS_AND_GAMEMODE_CONTRACT.md section 3). Diverging textures
  // and meshes don't shift FormIDs — for the same reason this script already
  // doesn't hash all of Data, only plugins and BSAs.
  //
  // Don't use it in production with a locked modpack: there the manifest must
  // cover content too, and then the default (no flag) is the right one.
  let entries = allFiles;
  if (args.onlyLoadOrder) {
    if (!args.pluginsTxt) {
      console.error('[manifest] --only-load-order requires --plugins-txt: without it there is no load order to restrict to.');
      process.exit(1);
    }
    const inOrder = new Set(readPluginsTxt(path.resolve(args.pluginsTxt)).map((p) => p.toLowerCase()));
    entries = allFiles.filter((name) => inOrder.has(name.toLowerCase()));
    console.log(`[manifest] --only-load-order: ${entries.length} of ${allFiles.length} files go into the manifest.`);
  }

  console.log(`[manifest] Hashing ${entries.length} files in ${dataDir}...`);
  const mods = [];
  for (const filename of entries) {
    const hash = await hashFile(path.join(dataDir, filename));
    mods.push({ filename, hash });
    process.stdout.write(`  ${filename} ${hash}\n`);
  }

  let loadOrder;
  if (args.pluginsTxt) {
    const pluginsTxtPath = path.resolve(args.pluginsTxt);
    if (!fs.existsSync(pluginsTxtPath)) {
      console.error(`[manifest] plugins.txt not found: ${pluginsTxtPath}`);
      process.exit(1);
    }
    loadOrder = readPluginsTxt(pluginsTxtPath);
    console.log(`[manifest] Load order read from ${pluginsTxtPath}: ${loadOrder.length} plugins.`);

    // Validate against all of Data, not against `entries`: with
    // `--only-load-order`, `entries` was derived from the load order itself,
    // and comparing the two would make the check agree with itself and never
    // flag a missing plugin.
    const known = new Set(allFiles.map((e) => e.toLowerCase()));
    const missing = loadOrder.filter((p) => !known.has(p.toLowerCase()));
    if (missing.length > 0) {
      console.error(`[manifest] ERROR: plugins in the load order that do not exist in Data/: ${missing.join(', ')}`);
      process.exit(1);
    }
  } else {
    loadOrder = entries.filter((name) => PLUGIN_EXTENSIONS.includes(path.extname(name).toLowerCase()));
    console.warn('[manifest] WARNING: --plugins-txt not given.');
    console.warn('[manifest] The load order was inferred from the directory\'s alphabetical order, which is NOT');
    console.warn('[manifest] the real Skyrim load order. Fine for local testing, but in production it');
    console.warn('[manifest] produces a manifest that rejects correct clients. Pass --plugins-txt.');
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    // Declared on purpose: the launcher rejects a manifest using another
    // algorithm with a message pointing at the cause, instead of flagging every
    // mod as corrupt.
    hashAlgorithm: HASH_ALGORITHM,
    sourceDataDir: dataDir,
    loadOrderSource: args.pluginsTxt ? 'plugins.txt' : 'directory-order (UNRELIABLE)',
    mods,
    loadOrder
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[manifest] Written to ${outPath}`);
  console.log(`[manifest] ${mods.length} files checked, ${loadOrder.length} plugins in the order.`);
}

main().catch((err) => {
  console.error('[manifest] Failed:', err.message);
  process.exit(1);
});
