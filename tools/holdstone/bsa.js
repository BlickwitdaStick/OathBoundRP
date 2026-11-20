// Minimal SSE BSA (v105) reader: list and extract files. LZ4 frame decoding inline.
// usage: node bsa.js list <bsa> [regex]
//        node bsa.js extract <bsa> <regex> <outdir>
const fs = require('fs');
const path = require('path');

function lz4Block(src, dst, dpos) {
  let s = 0;
  while (s < src.length) {
    const tok = src[s++];
    let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) dst[dpos++] = src[s++];
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4;
    let m = dpos - off;
    for (let i = 0; i < ml; i++) dst[dpos++] = dst[m++];
  }
  return dpos;
}

function lz4Frame(buf, size) {
  const out = Buffer.alloc(size);
  let p = 4; // magic
  const flg = buf[p]; p += 2; // FLG, BD
  if (flg & 0x08) p += 8; // content size
  if (flg & 0x01) p += 4; // dict id
  p += 1; // HC
  let dpos = 0;
  for (;;) {
    const bsz = buf.readUInt32LE(p); p += 4;
    if (bsz === 0) break;
    const raw = bsz & 0x80000000;
    const n = bsz & 0x7fffffff;
    const blk = buf.subarray(p, p + n); p += n;
    if (raw) { blk.copy(out, dpos); dpos += n; } else dpos = lz4Block(blk, out, dpos);
    if (flg & 0x10) p += 4;
  }
  return out;
}

function readBsa(file) {
  const fd = fs.openSync(file, 'r');
  const h = Buffer.alloc(36); fs.readSync(fd, h, 0, 36, 0);
  if (h.toString('latin1', 0, 4) !== 'BSA\0') throw new Error('not a BSA');
  const version = h.readUInt32LE(4);
  const flags = h.readUInt32LE(12);
  const folderCount = h.readUInt32LE(16);
  const fileCount = h.readUInt32LE(20);
  const totalFolderNameLen = h.readUInt32LE(24);
  const totalFileNameLen = h.readUInt32LE(28);
  const compressedDefault = Boolean(flags & 0x4);
  const embedNames = Boolean(flags & 0x100);
  const recSize = version === 105 ? 24 : 16;
  const st = fs.statSync(file);
  const headBytes = Math.min(st.size, 36 + folderCount * recSize + totalFolderNameLen + folderCount + fileCount * 16 + totalFileNameLen + 64);
  const b = Buffer.alloc(headBytes); fs.readSync(fd, b, 0, headBytes, 0);
  let p = 36;
  const folders = [];
  for (let i = 0; i < folderCount; i++) {
    folders.push({ count: b.readUInt32LE(p + 8) });
    p += recSize;
  }
  const files = [];
  for (const f of folders) {
    const nlen = b[p++];
    const name = b.toString('latin1', p, p + nlen - 1); p += nlen;
    for (let i = 0; i < f.count; i++) {
      const size = b.readUInt32LE(p + 8);
      const offset = b.readUInt32LE(p + 12);
      files.push({ folder: name, size, offset });
      p += 16;
    }
  }
  for (const f of files) {
    let e = p; while (b[e] !== 0) e++;
    f.name = f.folder + '\\' + b.toString('latin1', p, e);
    p = e + 1;
  }
  return {
    files,
    read(f) {
      let size = f.size & 0x3fffffff;
      const toggled = Boolean(f.size & 0x40000000);
      const comp = compressedDefault !== toggled;
      const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, f.offset);
      let q = 0;
      if (embedNames) q += buf[0] + 1;
      if (!comp) return buf.subarray(q);
      const orig = buf.readUInt32LE(q); q += 4;
      return lz4Frame(buf.subarray(q), orig);
    }
  };
}

const [cmd, bsaFile, pattern, outdir] = process.argv.slice(2);
const bsa = readBsa(bsaFile);
const re = pattern ? new RegExp(pattern, 'i') : null;
const hits = bsa.files.filter((f) => !re || re.test(f.name));
if (cmd === 'list') hits.forEach((f) => console.log(f.name));
else if (cmd === 'extract') {
  for (const f of hits) {
    const out = path.join(outdir, f.name.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bsa.read(f));
    console.log('extracted', f.name);
  }
}
