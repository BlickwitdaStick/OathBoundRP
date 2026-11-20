/**
 * core/plugin-record-index.js — searchable index of item and NPC records
 *
 * The F8 admin panel lets staff search "iron sword" or "wolf" instead of
 * typing a hex FormID. SkyMP has no API that lists the records of the loaded
 * plugins (`mp.lookupEspmRecordById` answers one id at a time, and
 * `mp.getAllForms` lists world references, not base records), so this module
 * reads the plugin files themselves — the same files the server loaded, taken
 * from `mp.getServerSettings()` (`dataDir` + `loadOrder`).
 *
 * Only the top-level groups that matter are read (item types and NPC_); every
 * other group is skipped by its size, so a 250 MB Skyrim.esm costs a few MB of
 * reads. The result is cached for the life of the process (the load order
 * cannot change while the server runs).
 *
 * FormIDs are converted to the server's global ids the way SkyMP does it:
 * the record's top byte indexes the plugin's own master list, and that plugin
 * name is looked up in the load order. Overrides in later plugins replace the
 * entry for the same global id (last plugin wins, like the game).
 *
 * Names: a localized plugin (TES4 flag 0x80, e.g. Skyrim.esm) stores FULL as a
 * string id; those are resolved through `mp.getLocalizedString(globalId)`,
 * which reads the .STRINGS files the server already has. Records without a
 * name fall back to their editor id.
 *
 * The plugin format parsing is pure (buffers in, entries out) so it is tested
 * with synthetic plugins in plugin-record-index.test.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Same allow-list as core/espm.js: records that make sense in an inventory. */
const ITEM_TYPES = Object.freeze(['WEAP', 'ARMO', 'MISC', 'ALCH', 'AMMO', 'BOOK', 'INGR', 'KEYM', 'SLGM', 'SCRL', 'LIGH']);
const NPC_TYPES = Object.freeze(['NPC_']);
const INDEXED_TYPES = new Set([...ITEM_TYPES, ...NPC_TYPES]);

const HEADER_SIZE = 24;
const FLAG_MASTER = 0x1;
const FLAG_LOCALIZED = 0x80;
/** TES4 flag of a light (ESL-flagged) plugin. */
const FLAG_LIGHT = 0x200;
const RECORD_FLAG_DELETED = 0x20;
const RECORD_FLAG_COMPRESSED = 0x00040000;

const MAX_RESULTS = 50;

/**
 * Reads the subrecords (fields) of one record's data.
 * Handles XXXX (a 32-bit size for the next field).
 * @param {Buffer} data
 * @returns {{type: string, data: Buffer}[]}
 */
function readFields(data) {
  const fields = [];
  let off = 0;
  let bigSize = null;
  while (off + 6 <= data.length) {
    const type = data.toString('latin1', off, off + 4);
    let size = data.readUInt16LE(off + 4);
    off += 6;
    if (type === 'XXXX') {
      bigSize = data.readUInt32LE(off);
      off += size;
      continue;
    }
    if (bigSize !== null) { size = bigSize; bigSize = null; }
    if (off + size > data.length) break;
    fields.push({ type, data: data.subarray(off, off + size) });
    off += size;
  }
  return fields;
}

function zstring(buf) {
  const end = buf.indexOf(0);
  return buf.toString('latin1', 0, end === -1 ? buf.length : end);
}

/**
 * Data of a record, decompressed when needed. Null when unreadable.
 * @param {Buffer} buf   - buffer holding the record
 * @param {number} off   - offset of the record header
 */
function recordData(buf, off) {
  const size = buf.readUInt32LE(off + 4);
  const flags = buf.readUInt32LE(off + 8);
  const raw = buf.subarray(off + HEADER_SIZE, off + HEADER_SIZE + size);
  if (!(flags & RECORD_FLAG_COMPRESSED)) return raw;
  try {
    return zlib.inflateSync(raw.subarray(4));
  } catch {
    return null;
  }
}

/**
 * Parses the TES4 header record: master list and whether strings are localized.
 * @param {Buffer} buf - at least the TES4 record
 */
function parseHeader(buf) {
  if (buf.length < HEADER_SIZE || buf.toString('latin1', 0, 4) !== 'TES4') {
    throw new Error('not a TES4 plugin');
  }
  const flags = buf.readUInt32LE(8);
  const size = buf.readUInt32LE(4);
  const masters = [];
  for (const field of readFields(buf.subarray(HEADER_SIZE, HEADER_SIZE + size))) {
    if (field.type === 'MAST') masters.push(zstring(field.data));
  }
  return {
    masters,
    localized: Boolean(flags & FLAG_LOCALIZED),
    isMaster: Boolean(flags & FLAG_MASTER),
    isLight: Boolean(flags & FLAG_LIGHT),
    headerSize: HEADER_SIZE + size
  };
}

/**
 * Records of one top-level group buffer (header included).
 * @param {Buffer} group
 * @param {(rec: {type:string, formId:number, editorId:string|null, full:Buffer|null, deleted:boolean}) => void} onRecord
 */
function walkGroup(group, onRecord) {
  let off = HEADER_SIZE;
  while (off + HEADER_SIZE <= group.length) {
    const type = group.toString('latin1', off, off + 4);
    const size = group.readUInt32LE(off + 4);
    if (type === 'GRUP') {
      // Nested group (not used by item/NPC groups, but harmless to support).
      walkGroup(group.subarray(off, off + size), onRecord);
      off += size;
      continue;
    }
    const flags = group.readUInt32LE(off + 8);
    const formId = group.readUInt32LE(off + 12);
    const data = recordData(group, off);
    off += HEADER_SIZE + size;
    if (!data) continue;
    let editorId = null;
    let full = null;
    for (const field of readFields(data)) {
      if (field.type === 'EDID') editorId = zstring(field.data);
      else if (field.type === 'FULL' && full === null) full = field.data;
    }
    onRecord({ type, formId, editorId, full, deleted: Boolean(flags & RECORD_FLAG_DELETED) });
  }
}

/**
 * Converts a plugin-local FormID to the server's global id.
 *
 * Numbering follows the game and the patched server (patches/skymp/
 * light-plugins.patch): full plugins take indexes 00, 01, 02… in load order,
 * skipping light ones; a light plugin's forms live in FE space,
 * 0xFE000000 | lightIndex << 12 | (id & 0xFFF). Counting light plugins as
 * full slots put every later plugin's items on the wrong index ("does not
 * exist in the loaded plugins", or a different record).
 *
 * @param {number} formId        - as stored in the plugin
 * @param {string[]} masters      - the plugin's MAST list
 * @param {string} selfName       - the plugin's own file name
 * @param {Map<string, number|{light: number}>} loadIndex - lower-case file name -> full index, or {light: n}
 * @returns {number|null}
 */
function toGlobalId(formId, masters, selfName, loadIndex) {
  const hi = formId >>> 24;
  const owner = hi < masters.length ? masters[hi] : selfName;
  const idx = loadIndex.get(String(owner).toLowerCase());
  if (idx === undefined) return null;
  if (typeof idx === 'object' && idx !== null) {
    return ((0xfe000000 | ((idx.light & 0xfff) << 12) | (formId & 0x00000fff)) >>> 0);
  }
  return ((idx << 24) >>> 0) + (formId & 0x00ffffff);
}

/** Light plugin? By extension, or by the ESL flag in its TES4 header. */
async function readIsLight(filePath, name) {
  if (/\.esl$/i.test(name)) return true;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(HEADER_SIZE);
    await fh.read(head, 0, HEADER_SIZE, 0);
    if (head.toString('latin1', 0, 4) !== 'TES4') return false;
    return Boolean(head.readUInt32LE(8) & FLAG_LIGHT);
  } finally {
    await fh.close();
  }
}

/**
 * file name -> index, numbered like the game: full plugins count 0,1,2…,
 * light plugins get {light: 0,1,2…} in their own sequence.
 * @param {{name: string, light: boolean}[]} files - in load order
 */
function buildLoadIndex(files) {
  const map = new Map();
  let full = 0;
  let light = 0;
  for (const f of files) {
    map.set(f.name.toLowerCase(), f.light ? { light: light++ } : full++);
  }
  return map;
}

/**
 * Parses one plugin given as a whole buffer (tests) — see `parsePluginFile`
 * for the streaming version used on the real files.
 */
function parsePluginBuffer(buf, selfName, loadIndex, types = INDEXED_TYPES) {
  const header = parseHeader(buf);
  const out = [];
  let off = header.headerSize;
  while (off + HEADER_SIZE <= buf.length) {
    const size = buf.readUInt32LE(off + 4);
    const label = buf.toString('latin1', off + 8, off + 12);
    if (types.has(label)) collect(buf.subarray(off, off + size), header, selfName, loadIndex, out);
    off += size;
  }
  return out;
}

function collect(group, header, selfName, loadIndex, out) {
  walkGroup(group, (rec) => {
    if (!INDEXED_TYPES.has(rec.type) || rec.deleted) return;
    const id = toGlobalId(rec.formId, header.masters, selfName, loadIndex);
    if (id === null) return;
    let name = null;
    let nameStringId = null;
    if (rec.full) {
      if (header.localized) nameStringId = rec.full.length >= 4 ? rec.full.readUInt32LE(0) : null;
      else name = zstring(rec.full) || null;
    }
    out.push({ id, type: rec.type, editorId: rec.editorId, name, nameStringId, plugin: selfName });
  });
}

/**
 * Streams a plugin from disk, reading only the wanted top-level groups.
 * @returns {Promise<object[]>}
 */
async function parsePluginFile(filePath, selfName, loadIndex, types = INDEXED_TYPES) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const head = Buffer.alloc(HEADER_SIZE);
    await fh.read(head, 0, HEADER_SIZE, 0);
    const tes4Size = HEADER_SIZE + head.readUInt32LE(4);
    const tes4 = Buffer.alloc(tes4Size);
    await fh.read(tes4, 0, tes4Size, 0);
    const header = parseHeader(tes4);

    const out = [];
    let off = header.headerSize;
    const gh = Buffer.alloc(HEADER_SIZE);
    while (off + HEADER_SIZE <= fileSize) {
      await fh.read(gh, 0, HEADER_SIZE, off);
      if (gh.toString('latin1', 0, 4) !== 'GRUP') break;
      const size = gh.readUInt32LE(4);
      if (size < HEADER_SIZE) break;
      const label = gh.toString('latin1', 8, 12);
      if (types.has(label)) {
        const group = Buffer.alloc(size);
        await fh.read(group, 0, size, off);
        collect(group, header, selfName, loadIndex, out);
      }
      off += size;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * Where the plugins are, from the server settings SkyMP itself parsed.
 * @param {{getServerSettings?: Function}} mpApi
 * @param {string} [cwd]
 * @returns {{dataDir: string, files: {name: string, path: string}[]}|null}
 */
function pluginsFromServerSettings(mpApi, cwd = process.cwd()) {
  if (!mpApi || typeof mpApi.getServerSettings !== 'function') return null;
  const settings = mpApi.getServerSettings() || {};
  if (typeof settings.dataDir !== 'string' || !Array.isArray(settings.loadOrder)) return null;
  const dataDir = path.resolve(cwd, settings.dataDir);
  const files = settings.loadOrder
    .filter((p) => typeof p === 'string' && p)
    .map((p) => ({ name: path.basename(p), path: path.isAbsolute(p) ? p : path.resolve(dataDir, p) }));
  return { dataDir, files };
}

/**
 * Builds the index from a list of plugin files, in load order.
 * @param {{name: string, path: string}[]} files
 * @param {{resolveName?: (globalId: number) => string|null|undefined, parseFile?: Function, log?: Function}} [opts]
 */
async function buildIndex(files, opts = {}) {
  const parseFile = opts.parseFile || parsePluginFile;
  const log = opts.log || (() => {});
  const isLight = opts.isLight || readIsLight;
  const flagged = [];
  for (const f of files) {
    let light = false;
    try { light = await isLight(f.path, f.name); } catch { light = /\.esl$/i.test(f.name); }
    flagged.push({ name: f.name, light });
  }
  const loadIndex = buildLoadIndex(flagged);
  const byId = new Map();
  const errors = [];
  for (const file of files) {
    try {
      const entries = await parseFile(file.path, file.name, loadIndex);
      for (const e of entries) byId.set(e.id, e); // later plugin overrides
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
      log(`[plugin-index] Could not read ${file.name}: ${err.message}`);
    }
  }
  const entries = [];
  for (const e of byId.values()) {
    let name = e.name;
    if (!name && e.nameStringId !== null && e.nameStringId !== undefined && opts.resolveName) {
      try { name = opts.resolveName(e.id) || null; } catch { name = null; }
    }
    entries.push({
      id: e.id,
      type: e.type,
      editorId: e.editorId || null,
      name: name || null,
      plugin: e.plugin,
      search: `${(name || '').toLowerCase()} ${(e.editorId || '').toLowerCase()}`
    });
  }
  return { entries, errors, builtAt: Date.now() };
}

/**
 * Ranks entries for a query. Matches every word against name + editor id;
 * a hex FormID (`0x12eb7` or `12eb7` with a hex letter) matches by id.
 * @param {object[]} entries
 * @param {{query?: string, types?: string[]|Set<string>, limit?: number}} q
 */
function search(entries, q = {}) {
  const types = q.types ? new Set(q.types) : null;
  const limit = Math.min(Math.max(Number(q.limit) || MAX_RESULTS, 1), MAX_RESULTS);
  const query = String(q.query || '').trim().toLowerCase().slice(0, 64);
  const pool = types ? entries.filter((e) => types.has(e.type)) : entries;

  const hex = /^(0x)?([0-9a-f]{1,8})$/.exec(query);
  if (hex && (hex[1] || /[a-f]/.test(hex[2]))) {
    const id = parseInt(hex[2], 16);
    return pool.filter((e) => e.id === id).slice(0, limit).map(publicEntry);
  }

  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return pool.filter((e) => e.name).sort(byName).slice(0, limit).map(publicEntry);
  }
  const scored = [];
  for (const e of pool) {
    if (!words.every((w) => e.search.includes(w))) continue;
    const name = (e.name || '').toLowerCase();
    let score = 3;
    if (name === query) score = 0;
    else if (name.startsWith(query)) score = 1;
    else if (name.includes(query)) score = 2;
    if (!e.name) score += 1; // unnamed (editor id only) after named
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || byName(a.e, b.e));
  return scored.slice(0, limit).map((s) => publicEntry(s.e));
}

function byName(a, b) {
  return String(a.name || a.editorId || '').localeCompare(String(b.name || b.editorId || ''));
}

function publicEntry(e) {
  return {
    baseId: e.id,
    idHex: `0x${e.id.toString(16).padStart(8, '0')}`,
    type: e.type,
    name: e.name || e.editorId || `0x${e.id.toString(16)}`,
    editorId: e.editorId,
    plugin: e.plugin
  };
}

/**
 * Lazily built, process-wide index bound to the live `mp`.
 * `get()` builds once; concurrent callers share the same promise.
 */
function createRecordIndex({ mpApi = () => (typeof mp !== 'undefined' ? mp : null), log = console.log } = {}) {
  let promise = null;
  let state = { status: 'idle', count: 0, error: null };

  function get() {
    if (promise) return promise;
    const api = mpApi();
    const plugins = pluginsFromServerSettings(api);
    if (!plugins || plugins.files.length === 0) {
      state = { status: 'unavailable', count: 0, error: 'The server settings do not list the plugins (dataDir/loadOrder).' };
      return Promise.resolve(null);
    }
    state = { status: 'building', count: 0, error: null };
    const started = Date.now();
    promise = buildIndex(plugins.files, {
      log,
      resolveName: api && typeof api.getLocalizedString === 'function'
        ? (id) => api.getLocalizedString(id)
        : null
    }).then((index) => {
      state = {
        status: 'ready',
        count: index.entries.length,
        error: index.errors.length ? index.errors.join('; ') : null
      };
      log(`[plugin-index] ${index.entries.length} item/NPC records indexed from ${plugins.files.length} plugins in ${Date.now() - started} ms.`);
      return index;
    }).catch((err) => {
      state = { status: 'failed', count: 0, error: err.message };
      promise = null; // allow a retry
      log(`[plugin-index] Failed: ${err.message}`);
      return null;
    });
    return promise;
  }

  return {
    get,
    status: () => ({ ...state }),
    async search(q) {
      const index = await get();
      return index ? search(index.entries, q) : null;
    },
    async findById(id) {
      const index = await get();
      if (!index) return null;
      const e = index.entries.find((x) => x.id === id);
      return e ? publicEntry(e) : null;
    },
    _reset() { promise = null; state = { status: 'idle', count: 0, error: null }; }
  };
}

module.exports = {
  ITEM_TYPES,
  NPC_TYPES,
  MAX_RESULTS,
  readFields,
  parseHeader,
  parsePluginBuffer,
  parsePluginFile,
  toGlobalId,
  buildLoadIndex,
  readIsLight,
  pluginsFromServerSettings,
  buildIndex,
  search,
  createRecordIndex
};
