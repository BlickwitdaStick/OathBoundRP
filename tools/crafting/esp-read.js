/**
 * Minimal plugin reader for the crafting tools: walks the wanted top-level
 * groups of each plugin and hands back raw records with their fields.
 * Forms are named by "form keys" (origin plugin lower-case + local id) so
 * nothing depends on load-order indexes.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

const HEADER = 24;
const FLAG_COMPRESSED = 0x00040000;
const FLAG_DELETED = 0x20;

function readFields(data) {
  const out = [];
  let off = 0;
  let big = null;
  while (off + 6 <= data.length) {
    const type = data.toString('latin1', off, off + 4);
    let size = data.readUInt16LE(off + 4);
    off += 6;
    if (type === 'XXXX') { big = data.readUInt32LE(off); off += size; continue; }
    if (big !== null) { size = big; big = null; }
    if (off + size > data.length) break;
    out.push({ type, data: data.subarray(off, off + size) });
    off += size;
  }
  return out;
}

function zstring(buf) {
  const end = buf.indexOf(0);
  return buf.toString('latin1', 0, end === -1 ? buf.length : end);
}

function parseHeader(buf) {
  const size = buf.readUInt32LE(4);
  const flags = buf.readUInt32LE(8);
  const masters = [];
  for (const f of readFields(buf.subarray(HEADER, HEADER + size))) {
    if (f.type === 'MAST') masters.push(zstring(f.data));
  }
  return { flags, masters, localized: Boolean(flags & 0x80), light: Boolean(flags & 0x200), headerSize: HEADER + size };
}

function walk(group, cb) {
  let off = HEADER;
  while (off + HEADER <= group.length) {
    const type = group.toString('latin1', off, off + 4);
    const size = group.readUInt32LE(off + 4);
    if (type === 'GRUP') { walk(group.subarray(off, off + size), cb); off += size; continue; }
    const flags = group.readUInt32LE(off + 8);
    const formId = group.readUInt32LE(off + 12);
    let data = group.subarray(off + HEADER, off + HEADER + size);
    off += HEADER + size;
    if (flags & FLAG_COMPRESSED) {
      try { data = zlib.inflateSync(data.subarray(4)); } catch { continue; }
    }
    cb({ type, flags, formId, deleted: Boolean(flags & FLAG_DELETED), fields: readFields(data) });
  }
}

/**
 * @param {string} filePath
 * @param {string} selfName
 * @param {Set<string>} types top-level group labels to read
 * @param {(rec: object, header: object) => void} cb  rec gets `key(localFormId)` helper
 */
function readPlugin(filePath, selfName, types, cb) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const head = Buffer.alloc(HEADER);
    fs.readSync(fd, head, 0, HEADER, 0);
    const tes4 = Buffer.alloc(HEADER + head.readUInt32LE(4));
    fs.readSync(fd, tes4, 0, tes4.length, 0);
    const header = parseHeader(tes4);
    const owners = header.masters.map((m) => m.toLowerCase());
    const self = selfName.toLowerCase();
    const key = (id) => {
      const hi = id >>> 24;
      const owner = hi < owners.length ? owners[hi] : self;
      return `${owner}|${(id & 0xffffff).toString(16)}`;
    };
    let off = header.headerSize;
    const gh = Buffer.alloc(HEADER);
    while (off + HEADER <= fileSize) {
      fs.readSync(fd, gh, 0, HEADER, off);
      if (gh.toString('latin1', 0, 4) !== 'GRUP') break;
      const size = gh.readUInt32LE(4);
      const label = gh.toString('latin1', 8, 12);
      if (types.has(label)) {
        const group = Buffer.alloc(size);
        fs.readSync(fd, group, 0, size, off);
        walk(group, (rec) => { rec.key = key(rec.formId); rec.ref = key; cb(rec, header); });
      }
      off += size;
    }
    return header;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readPlugin, readFields, zstring };
