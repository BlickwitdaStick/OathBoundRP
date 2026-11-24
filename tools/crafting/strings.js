/**
 * Reads localized names: <plugin>_english.strings from loose Data/Strings or
 * from a BSA (v104/v105, uncompressed entries) next to the plugin.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readBsaFile(bsaPath, wanted) {
  if (!fs.existsSync(bsaPath)) return null;
  const b = fs.readFileSync(bsaPath);
  if (b.toString('latin1', 0, 4) !== 'BSA\0') return null;
  const version = b.readUInt32LE(4);
  const flags = b.readUInt32LE(12);
  const folderCount = b.readUInt32LE(16);
  const fileCount = b.readUInt32LE(20);
  const recSize = version === 105 ? 24 : 16;
  const embedNames = Boolean(flags & 0x100);
  const compressedDefault = Boolean(flags & 0x4);
  let off = 36;
  const folders = [];
  for (let i = 0; i < folderCount; i++) {
    folders.push({ count: b.readUInt32LE(off + 8) });
    off += recSize;
  }
  const files = [];
  for (const f of folders) {
    const len = b.readUInt8(off);
    f.name = b.toString('latin1', off + 1, off + len).toLowerCase();
    off += 1 + len;
    for (let i = 0; i < f.count; i++) {
      files.push({ folder: f.name, size: b.readUInt32LE(off + 8), offset: b.readUInt32LE(off + 12) });
      off += 16;
    }
  }
  for (let i = 0; i < fileCount; i++) {
    const end = b.indexOf(0, off);
    files[i].name = b.toString('latin1', off, end).toLowerCase();
    off = end + 1;
  }
  const target = wanted.toLowerCase().replace(/\//g, '\\');
  const hit = files.find((f) => `${f.folder}\\${f.name}` === target);
  if (!hit) return null;
  let start = hit.offset;
  let size = hit.size & 0x3fffffff;
  const compressed = compressedDefault !== Boolean(hit.size & 0x40000000);
  if (embedNames) { const l = b.readUInt8(start); start += 1 + l; size -= 1 + l; }
  if (compressed) throw new Error(`${wanted} is compressed in ${path.basename(bsaPath)}`);
  return b.subarray(start, start + size);
}

function parseStrings(buf) {
  const count = buf.readUInt32LE(0);
  const base = 8 + count * 8;
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const id = buf.readUInt32LE(8 + i * 8);
    const at = base + buf.readUInt32LE(12 + i * 8);
    const end = buf.indexOf(0, at);
    map.set(id, buf.toString('utf8', at, end));
  }
  return map;
}

/** id -> name for a localized plugin, or an empty map. */
function loadStrings(dataDir, plugin) {
  const base = plugin.replace(/\.(esm|esp|esl)$/i, '');
  const rel = `strings\\${base}_english.strings`;
  const loose = path.join(dataDir, 'Strings', `${base}_english.strings`);
  try {
    if (fs.existsSync(loose)) return parseStrings(fs.readFileSync(loose));
    const candidates = [`${base}.bsa`, `${base} - Interface.bsa`];
    if (/^(skyrim|update|dawnguard|hearthfires|dragonborn)$/i.test(base)) candidates.push('Skyrim - Interface.bsa');
    for (const c of candidates) {
      const buf = readBsaFile(path.join(dataDir, c), rel);
      if (buf) return parseStrings(buf);
    }
  } catch (err) {
    console.warn(`[strings] ${plugin}: ${err.message}`);
  }
  return new Map();
}

module.exports = { loadStrings, readBsaFile, parseStrings };
