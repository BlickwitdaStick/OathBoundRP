/**
 * Reads the parts of Skyrim.esm the temple table needs: worldspaces, cells
 * (interior and exterior), and the placed references inside them that are
 * doors (have XTEL) or markers. Each reference keeps the cell or worldspace
 * that holds it, which the flat reader in tools/crafting/esp-read.js does
 * not track.
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

function field(fields, type) {
  return fields.find((f) => f.type === type);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {string} file path to Skyrim.esm
 * @param {Set<number>} markerBases base ids of markers to keep (XMarker, XMarkerHeading)
 */
function readCells(file, markerBases) {
  const buf = fs.readFileSync(file);
  const worlds = new Map();   // id -> { id, edid, parent }
  const cells = new Map();    // id -> { id, edid, interior, world, location }
  const doors = new Map();    // ref id -> { id, base, container, pos, rot, dest }
  const markers = [];         // { id, base, container, pos, rot }

  const record = (off) => {
    const type = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const flags = buf.readUInt32LE(off + 8);
    const formId = buf.readUInt32LE(off + 12);
    let data = buf.subarray(off + HEADER, off + HEADER + size);
    if (flags & FLAG_COMPRESSED) data = zlib.inflateSync(data.subarray(4));
    return { type, size, flags, formId, fields: readFields(data) };
  };

  // ctx: { world, cell } of the enclosing groups
  const walk = (start, end, ctx) => {
    let off = start;
    let lastCell = null;
    while (off + HEADER <= end) {
      const type = buf.toString('latin1', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (type === 'GRUP') {
        const groupType = buf.readInt32LE(off + 12);
        const label = buf.readUInt32LE(off + 8);
        let next = ctx;
        if (groupType === 1) next = { world: label, cell: null };
        else if (groupType === 6) next = { world: ctx.world, cell: label };
        walk(off + HEADER, off + size, next);
        off += size;
        continue;
      }
      const flags = buf.readUInt32LE(off + 8);
      if (type === 'WRLD') {
        const r = record(off);
        const edid = field(r.fields, 'EDID');
        const wnam = field(r.fields, 'WNAM');
        worlds.set(r.formId, { id: r.formId, edid: edid ? zstring(edid.data) : '', parent: wnam ? wnam.data.readUInt32LE(0) : 0 });
      } else if (type === 'CELL') {
        const r = record(off);
        const edid = field(r.fields, 'EDID');
        const data = field(r.fields, 'DATA');
        const xlcn = field(r.fields, 'XLCN');
        const interior = data ? Boolean(data.data.readUInt8(0) & 1) : false;
        lastCell = {
          id: r.formId,
          edid: edid ? zstring(edid.data) : '',
          interior,
          world: interior ? 0 : (ctx.world || 0),
          location: xlcn ? xlcn.data.readUInt32LE(0) : 0,
          deleted: Boolean(flags & FLAG_DELETED)
        };
        cells.set(r.formId, lastCell);
      } else if (type === 'REFR' && ctx.cell && !(flags & FLAG_DELETED)) {
        // Cheap pre-check before inflating: only doors and markers matter.
        const r = record(off);
        const name = field(r.fields, 'NAME');
        const dataF = field(r.fields, 'DATA');
        if (name && dataF && dataF.data.length >= 24) {
          const base = name.data.readUInt32LE(0);
          const d = dataF.data;
          const pos = [round(d.readFloatLE(0)), round(d.readFloatLE(4)), round(d.readFloatLE(8))];
          const rot = [d.readFloatLE(12), d.readFloatLE(16), d.readFloatLE(20)];
          const xtel = field(r.fields, 'XTEL');
          if (xtel) {
            const x = xtel.data;
            doors.set(r.formId, {
              id: r.formId,
              base,
              container: ctx.cell,
              pos,
              rot,
              dest: {
                door: x.readUInt32LE(0),
                pos: [round(x.readFloatLE(4)), round(x.readFloatLE(8)), round(x.readFloatLE(12))],
                rot: [x.readFloatLE(16), x.readFloatLE(20), x.readFloatLE(24)]
              }
            });
          } else if (markerBases.has(base)) {
            markers.push({ id: r.formId, base, container: ctx.cell, pos, rot });
          }
        }
      }
      off += HEADER + size;
    }
  };

  const tes4Size = buf.readUInt32LE(4);
  let off = HEADER + tes4Size;
  while (off + HEADER <= buf.length) {
    const size = buf.readUInt32LE(off + 4);
    const label = buf.toString('latin1', off + 8, off + 12);
    if (label === 'CELL' || label === 'WRLD') walk(off + HEADER, off + size, { world: 0, cell: null });
    off += size;
  }

  // Exterior cells in a world's children group carry the world id from ctx.
  return { worlds, cells, doors, markers };
}

module.exports = { readCells, zstring };
