/**
 * parity.mjs — modpack parity check, with no I/O
 *
 * This is the logic that upholds the **FormID contract**
 * (`docs/technical/MODS_AND_GAMEMODE_CONTRACT.md` §3): the server stores
 * `base_id` in the database, and a FormID only means something inside a
 * specific load order. If the player's order differs from the server's in a
 * single position, the same `base_id` becomes a different item on their screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this became its own module
 * ─────────────────────────────────────────────────────────────────────────────
 * It used to live inside `main.ts`'s `ipcMain.handle` handlers, mixed with
 * disk reads and HTTP — that is, impossible to test without Electron, a server
 * and a real `Data/` folder. Practical result: the launcher had **zero
 * tests**, and it is what decides whether a player gets in or not.
 *
 * There is no `fs`, `http` or `electron` here. I/O dependencies come in as
 * arguments (`readHeader`, `hashOf`). It is plain JS (`.mjs`) and not
 * TypeScript on purpose: that way `node --test` runs directly, with no build
 * step — the same choice as the gamemode.
 *
 * Written as ESM because `apps/launcher` is `"type": "module"`.
 */

/**
 * Parses Skyrim's `plugins.txt`.
 *
 * Format: one line per plugin, `*` in front when it is active, `#` for a
 * comment. Anything **without** `*` is present on disk but outside the load
 * order — and so shifts no FormID.
 *
 * @param {string} content
 * @returns {{name: string, enabled: boolean}[]}
 */
export function parsePluginsTxt(content) {
  if (typeof content !== 'string') return [];
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => ({ name: line.replace(/^\*/, ''), enabled: line.startsWith('*') }));
}

/**
 * Reads a plugin's TES4 header from the file's buffer.
 *
 * Takes a **buffer**, not a path: that is what makes the parser testable with
 * a 60-byte synthetic plugin instead of a 300 MB `.esm`.
 *
 * @param {Buffer} buffer
 * @returns {{masters: string[], isMaster: boolean, isLight: boolean, error?: string}}
 */
export function parsePluginHeader(buffer) {
  const empty = { masters: [], isMaster: false, isLight: false };

  if (!buffer || buffer.length < 24) {
    return { ...empty, error: 'File is smaller than the TES4 header' };
  }
  if (buffer.toString('latin1', 0, 4) !== 'TES4') {
    return { ...empty, error: 'Invalid TES4 header' };
  }

  const dataSize = buffer.readUInt32LE(4);
  const flags = buffer.readUInt32LE(8);
  const isMaster = (flags & 0x1) !== 0;
  const isLight = (flags & 0x200) !== 0;

  // 1 MiB cap: the masters block lives at the start, and with no limit a file
  // with a corrupted `dataSize` would make the launcher allocate arbitrary
  // memory from a number that came from outside.
  const cap = Math.min(dataSize, 1024 * 1024, Math.max(0, buffer.length - 24));
  const data = buffer.subarray(24, 24 + cap);

  const masters = [];
  let offset = 0;
  while (offset + 6 <= data.length) {
    const type = data.toString('latin1', offset, offset + 4);
    const size = data.readUInt16LE(offset + 4);
    const start = offset + 6;
    const end = start + size;
    if (end > data.length) break;
    if (type === 'MAST') {
      const value = data.toString('utf8', start, end);
      // MAST is NUL-terminated; without trimming, the name carries the null
      // byte and never matches the file on disk.
      const nul = value.indexOf(String.fromCharCode(0));
      const name = (nul >= 0 ? value.slice(0, nul) : value).trim();
      if (name) masters.push(name);
    }
    offset = end;
  }

  return { masters, isMaster, isLight };
}

/**
 * Compares local content against the server manifest.
 *
 * `hashOf` is async on purpose: a reference `.esm`/`.bsa` easily goes past
 * 200-300 MB, and a synchronous `hashOf` (e.g. a whole `fs.readFileSync` before
 * hashing) forces Node to allocate the whole file on the heap at once per mod
 * — with manifests of dozens of mods, that blew the launcher process's memory
 * before the game even opened. An async `hashOf` (e.g. hashing via a stream)
 * lets the caller control that.
 *
 * Hashes run with `concurrency` files "in flight" at once, not one at a time:
 * hashing a manifest with dozens of reference BSAs sequentially left the disk
 * mostly idle between reads and took minutes (real finding: ~5 min on an
 * external fork's modpack). This doesn't reopen the memory problem that
 * motivated streaming — each stream still holds only one chunk of the file at
 * a time; `concurrency` only controls how many DIFFERENT files are read at once.
 *
 * @param {Object}   params
 * @param {{filename: string, hash: string}[]} params.serverMods
 * @param {string[]} params.localFiles  names of the files in `Data/`
 * @param {(filename: string) => (string | Promise<string>)} params.hashOf  hash of the local file
 * @param {number}   [params.concurrency]  files hashed in parallel (default 4)
 */
export const HASH_ALGORITHM = 'sha256';

export async function compareMods({ serverMods, localFiles, hashOf, hashAlgorithm, concurrency = 4 }) {
  if (!Array.isArray(serverMods)) {
    return { success: false, error: 'Invalid manifest from the server.' };
  }

  // The manifest declares which algorithm it was generated with. Without this
  // check, an old mods.json (MD5) against a new launcher (SHA-256) would make
  // EVERY file differ, and the player would read "your mod is corrupted" two
  // hundred times -- a lie about the cause. The failure mode has to point at
  // what really happened: the manifest needs regenerating.
  if (hashAlgorithm !== HASH_ALGORITHM) {
    return {
      success: false,
      error: `Manifest generated with '${hashAlgorithm || 'undeclared algorithm'}', but this `
        + `launcher requires ${HASH_ALGORITHM}. Ask the server to regenerate mods.json.`
    };
  }

  // Windows is case-insensitive; the manifest is generated on another machine.
  const byLowerName = new Map(localFiles.map(f => [f.toLowerCase(), f]));

  // A missing file is a cheap check (it only looks at the Map) — resolve all of
  // them before spending I/O on hashing, in manifest order, so the error
  // message stays predictable when a missing mod comes before a bad hash.
  const resolved = [];
  for (const mod of serverMods) {
    const local = byLowerName.get(String(mod.filename).toLowerCase());
    if (!local) {
      return { success: false, error: `Missing mod: ${mod.filename}` };
    }
    resolved.push({ mod, local });
  }

  let cursor = 0;
  let mismatch = null;

  async function worker() {
    while (cursor < resolved.length) {
      const index = cursor++;
      const { mod, local } = resolved[index];
      const hash = await hashOf(local);
      if (hash !== mod.hash && (mismatch === null || index < mismatch.index)) {
        mismatch = { index, filename: mod.filename };
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, resolved.length));
  await Promise.all(Array.from({ length: workers }, worker));

  if (mismatch) {
    return { success: false, error: `The mod ${mismatch.filename} is modified or corrupted!` };
  }

  return { success: true };
}

/**
 * Checks the load order against the server's.
 *
 * Three classes of problem, and the third is the one that was missing:
 *
 *   1. **Missing plugin** — the server requires it and the player doesn't have it.
 *   2. **Master out of order** — the dependency loads after the dependent.
 *   3. **Extra plugin** — the player has a plugin the server doesn't know.
 *
 * Case 3 is the most dangerous and was the one slipping through. One extra
 * `.esp` in the load order takes an index and **shifts every following
 * plugin**: the `HeavyRP.esm` that is `02` on the server becomes `03` on the
 * client, and every `base_id` stored in the database starts pointing at a
 * different record on that player's screen.
 *
 * It slipped through because both checks ran **in the wrong direction**: both
 * walked the server's list asking "does the player have this?", and neither
 * walked the player's asking "does the server know this?".
 *
 * `enabledPlugins` (from `plugins.txt`) is what defines the real load order.
 * Without it, the check falls back to the files present in `Data/` — coarser,
 * because a plugin that is present but disabled shifts nothing, but it is the
 * safe direction: a false positive here is "you have a file you shouldn't".
 *
 * @param {Object} params
 * @param {string[]} params.localPlugins           plugin files in `Data/`
 * @param {string[]} params.serverLoadOrder        the server's canonical order
 * @param {string[]} [params.enabledPlugins]       active in `plugins.txt`
 * @param {(name: string) => Object} params.readHeader
 */
export function analyzePlugins({ localPlugins, serverLoadOrder, enabledPlugins, readHeader }) {
  const problems = [];
  const plugins = [];

  const localByLower = new Map(localPlugins.map(f => [f.toLowerCase(), f]));

  // With no server order there is no parity to check. The code used to fall
  // back to the local order, which made the check compare the player with
  // themselves and always answer "ok" -- the worst possible answer, because it
  // looks like approval.
  if (!Array.isArray(serverLoadOrder) || serverLoadOrder.length === 0) {
    return {
      ok: false,
      problems: ['The server did not provide a load order: parity cannot be checked.'],
      plugins: []
    };
  }

  const declared = serverLoadOrder.map(String);
  const declaredIndex = new Map(declared.map((f, i) => [f.toLowerCase(), i]));

  // First pass: presence and header. It has to come before the effective
  // order because the ESM flag, which decides hoisting, lives in the header.
  const headers = new Map();
  for (const plugin of declared) {
    const localName = localByLower.get(plugin.toLowerCase());
    if (!localName) {
      problems.push(`Missing plugin: ${plugin}`);
      continue;
    }
    const header = readHeader(localName);
    plugins.push({ name: localName, ...header });
    if (header.error) problems.push(`${localName}: ${header.error}`);
    headers.set(plugin.toLowerCase(), { localName, header });
  }

  const present = declared.filter(p => headers.has(p.toLowerCase()));
  const effectiveOrder = [...present.filter(isHoisted), ...present.filter(p => !isHoisted(p))];
  const effectivePos = new Map(effectiveOrder.map((p, i) => [p.toLowerCase(), i]));

  function isHoisted(plugin) {
    const entry = headers.get(plugin.toLowerCase());
    if (!entry) return false;
    const ext = plugin.toLowerCase().slice(plugin.lastIndexOf('.'));
    // `isLight` is NOT part of this, and that absence is the whole point of this function.
    return ext === '.esm' || ext === '.esl' || !!entry.header.isMaster;
  }

  // Second pass: master order, compared in the EFFECTIVE order.
  for (const plugin of effectiveOrder) {
    const { localName, header } = headers.get(plugin.toLowerCase());

    for (const master of header.masters || []) {
      if (!localByLower.has(master.toLowerCase())) {
        problems.push(`${localName}: missing master ${master}`);
        continue;
      }
      // A master present on disk but outside the server order is a base ESM:
      // the engine loads it before everything, so there is nothing to check
      // here. The extra-plugin loop below decides whether it should exist.
      const iMaster = effectivePos.get(master.toLowerCase());
      const iPlugin = effectivePos.get(plugin.toLowerCase());
      if (iMaster !== undefined && iPlugin !== undefined && iMaster > iPlugin) {
        problems.push(`${localName}: master ${master} loads after the plugin`);
      }
    }
  }

  // The missing direction.
  // An active plugins.txt entry with no file in Data/ doesn't load: the game
  // skips the missing plugin and it takes no index, so it shifts no FormID.
  // That is the case of a plugin the server renamed and the player never downloaded.
  const candidates = Array.isArray(enabledPlugins) && enabledPlugins.length > 0
    ? enabledPlugins.filter(p => localByLower.has(String(p).toLowerCase()))
    : localPlugins;

  for (const local of candidates) {
    if (!declaredIndex.has(String(local).toLowerCase())) {
      problems.push(
        `Extra plugin in the load order: ${local}. It shifts the FormIDs of every ` +
        `following plugin, so the server's items would show up swapped.`
      );
    }
  }

  return { ok: problems.length === 0, problems, plugins };
}

/**
 * Parses `Skyrim.ccc`.
 *
 * Format: one plugin name per line, no `*` — unlike `plugins.txt`, because
 * there is no "disabled" here. Whatever is listed and present on disk loads,
 * full stop.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function parseCccTxt(content) {
  if (typeof content !== 'string') return [];
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * Checks Creation Club content parity — the gap `analyzePlugins` doesn't cover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this function exists
 * ─────────────────────────────────────────────────────────────────────────────
 * `analyzePlugins` compares the player's `plugins.txt` with the server order.
 * **Creation Club content never appears in `plugins.txt`.** Skyrim AE reads
 * `Skyrim.ccc`, loads whatever is listed *and present in `Data/`*, and slots
 * those plugins right after the vanilla masters — taking indexes the server
 * doesn't know about.
 *
 * Since the first byte of every FormID is the load order index, the effect is
 * the same as an "extra plugin": the database `base_id` starts pointing at
 * another record on that player's screen. No error and no log — the symptom is
 * a chest with something else inside (QA failure 2.15).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What makes this worse than an extra mod
 * ─────────────────────────────────────────────────────────────────────────────
 * The contents of `Skyrim.ccc` **vary with what that Steam account owns**. It
 * is not the same file for two testers, and the player chose none of it. A
 * checker that only looks at `Data/` against the manifest doesn't see the
 * difference, because the files may well be there — what changes is what the
 * executable decides to load.
 *
 * That is why the check is bidirectional, like `analyzePlugins`:
 *
 * - CC the player loads and the server doesn't declare → shifts an index;
 * - CC the server declares and the player doesn't load → a record is missing.
 *
 * The second direction is the risk of requiring Creation Club in the official
 * modpack: it only passes if **every** player has exactly the same CC licences.
 *
 * @param {Object} params
 * @param {string[]} params.cccEntries        lines of `Skyrim.ccc` (via `parseCccTxt`)
 * @param {string[]} params.localPlugins      plugin files present in `Data/`
 * @param {string[]} params.serverLoadOrder   the server's canonical order
 * @returns {{ok: boolean, problems: string[], effective: string[]}}
 */
export function analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder, enabledPlugins }) {
  const problems = [];

  if (!Array.isArray(serverLoadOrder) || serverLoadOrder.length === 0) {
    return {
      ok: false,
      problems: ['The server did not provide a load order: Creation Club parity cannot be checked.'],
      effective: []
    };
  }

  const present = new Set((localPlugins || []).map(f => String(f).toLowerCase()));
  const inOrder = new Set(serverLoadOrder.map(f => String(f).toLowerCase()));

  // Listed in the .ccc *and* present on disk. An entry with no file doesn't
  // load and shifts nothing — treating it as a problem would be a false
  // positive on every install that didn't buy everything.
  // Listed in Skyrim.ccc OR enabled in plugins.txt (the OATHBOUND launcher
  // enables the CC masters a mod needs there; the install has no Skyrim.ccc).
  const viaPluginsTxt = (enabledPlugins || []).filter(n => /^cc[a-z0-9]/i.test(String(n)));
  const effective = [...new Set([...(cccEntries || []), ...viaPluginsTxt].map(String))]
    .filter(name => present.has(name.toLowerCase()));

  for (const cc of effective) {
    if (!inOrder.has(String(cc).toLowerCase())) {
      problems.push(
        `Active Creation Club plugin outside the server load order: ${cc}. The game loads ` +
        `this plugin by itself, through Skyrim.ccc, even when it is not in plugins.txt — ` +
        `and it shifts the FormIDs of every following plugin.`
      );
    }
  }

  // Reverse direction: the server counts on a CC plugin this player doesn't load.
  const effectiveLower = new Set(effective.map(n => String(n).toLowerCase()));
  for (const declaredName of serverLoadOrder) {
    const name = String(declaredName);
    if (!/^cc[a-z0-9]/i.test(name)) continue; // Creation Club content only
    if (!effectiveLower.has(name.toLowerCase())) {
      problems.push(
        `Creation Club plugin required by the server is missing: ${name}. Either the Steam ` +
        `account doesn't own this content, or it isn't listed in Skyrim.ccc.`
      );
    }
  }

  return { ok: problems.length === 0, problems, effective };
}
