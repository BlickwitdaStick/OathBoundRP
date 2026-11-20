// Writes small uncompressed BGRA DDS textures (with mipmaps) for the holdstone rune.
// usage: node make_dds.js <outdir>
const fs = require('fs');
const path = require('path');

function dds(size, pixelFn) {
  const levels = Math.log2(size) + 1;
  const header = Buffer.alloc(128);
  header.write('DDS ', 0, 'latin1');
  header.writeUInt32LE(124, 4);
  // CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | MIPMAPCOUNT
  header.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x8 | 0x1000 | 0x20000, 8);
  header.writeUInt32LE(size, 12);
  header.writeUInt32LE(size, 16);
  header.writeUInt32LE(size * 4, 20);
  header.writeUInt32LE(levels, 28);
  header.writeUInt32LE(32, 76);          // pixel format size
  header.writeUInt32LE(0x41, 80);        // RGB | ALPHAPIXELS
  header.writeUInt32LE(32, 88);          // bit count
  header.writeUInt32LE(0x00ff0000, 92);  // R
  header.writeUInt32LE(0x0000ff00, 96);  // G
  header.writeUInt32LE(0x000000ff, 100); // B
  header.writeUInt32LE(0xff000000, 104); // A
  header.writeUInt32LE(0x1000 | 0x400000 | 0x8, 108); // TEXTURE | MIPMAP | COMPLEX
  const parts = [header];
  for (let s = size; s >= 1; s >>= 1) {
    const buf = Buffer.alloc(s * s * 4);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const [r, g, b, a] = pixelFn(x / s, y / s);
      const o = (y * s + x) * 4;
      buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = a;
    }
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

const out = process.argv[2];
const dir = path.join(out, 'textures', 'oathbound', 'holdstone');
fs.mkdirSync(dir, { recursive: true });
// Rune face: pale icy blue, a little brighter in the middle of each stroke (v runs across the stroke).
const across = (v) => 1 - Math.abs(v - 0.5) * 2;
fs.writeFileSync(path.join(dir, 'holdstonerune.dds'), dds(64, (u, v) => {
  const k = 0.75 + 0.25 * across(v);
  return [Math.round(170 * k), Math.round(215 * k), 255, 255];
}));
fs.writeFileSync(path.join(dir, 'holdstonerune_g.dds'), dds(64, (u, v) => {
  const k = Math.round(150 + 105 * across(v));
  return [k, k, k, 255];
}));
fs.writeFileSync(path.join(dir, 'holdstonerune_n.dds'), dds(64, () => [128, 128, 255, 0]));
console.log('wrote', fs.readdirSync(dir).join(', '));
