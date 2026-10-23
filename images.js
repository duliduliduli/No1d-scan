// Banner and icon checks. Types come from the bytes, not the browser's filename.
// EXIF, XMP and text chunks are dropped. Dimensions over the limit are refused, not resized.
const zlib = require('node:zlib');

const LIMITS = {
  banner: { w: 1500, h: 500, bytes: 1_000_000 },
  icon: { w: 512, h: 512, bytes: 256_000 },
};
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

const bad = (m) => Object.assign(new Error(m), { status: 400 });

function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function pngSize(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw bad('broken PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function stripPng(buf) {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
  const out = [buf.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const end = o + 12 + len;
    if (end > buf.length) throw bad('broken PNG');
    if (keep.has(type)) out.push(buf.subarray(o, end));
    o = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function jpegSize(buf) {
  let o = 2;
  while (o + 3 < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const mark = buf[o + 1];
    if (mark === 0xd8 || mark === 0xd9 || (mark >= 0xd0 && mark <= 0xd7) || mark === 0x01) { o += 2; continue; }
    if (o + 4 > buf.length) break;
    const len = buf.readUInt16BE(o + 2);
    if (mark >= 0xc0 && mark <= 0xc2) {
      if (o + 9 > buf.length) break;
      return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
    }
    if (mark === 0xda) break;
    o += 2 + len;
  }
  throw bad('broken JPEG');
}
// Drop APP1 (EXIF), APP13 (IPTC) and comment segments. The rest of the file is copied through.
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let o = 2;
  while (o + 3 < buf.length) {
    if (buf[o] !== 0xff) break;
    const mark = buf[o + 1];
    if (mark === 0xd9) { out.push(buf.subarray(o, o + 2)); break; }
    if (mark === 0xd8 || (mark >= 0xd0 && mark <= 0xd7) || mark === 0x01) { out.push(buf.subarray(o, o + 2)); o += 2; continue; }
    const len = buf.readUInt16BE(o + 2);
    const end = o + 2 + len;
    if (end > buf.length) throw bad('broken JPEG');
    const drop = mark === 0xe1 || mark === 0xed || mark === 0xfe;
    if (mark === 0xda) { out.push(buf.subarray(o)); break; }
    if (!drop) out.push(buf.subarray(o, end));
    o = end;
  }
  return Buffer.concat(out);
}

function webpSize(buf) {
  let o = 12;
  let fromVp8x = null;
  while (o + 8 <= buf.length) {
    const tag = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    const data = o + 8;
    const end = data + len + (len & 1);
    if (end > buf.length) break;
    if (tag === 'VP8X' && len >= 10) {
      const w = 1 + buf.readUIntLE(data + 4, 3);
      const h = 1 + buf.readUIntLE(data + 7, 3);
      fromVp8x = { w, h };
    } else if (tag === 'VP8 ' && len >= 10 && !fromVp8x) {
      const w = buf.readUInt16LE(data + 6) & 0x3fff;
      const h = buf.readUInt16LE(data + 8) & 0x3fff;
      return { w, h };
    } else if (tag === 'VP8L' && len >= 5 && buf[data] === 0x2f && !fromVp8x) {
      const b = buf.readUInt32LE(data + 1);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    o = end;
  }
  if (fromVp8x) return fromVp8x;
  throw bad('broken WebP');
}
function stripWebp(buf) {
  const chunks = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const tag = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    const end = o + 8 + len + (len & 1);
    if (end > buf.length) throw bad('broken WebP');
    if (tag !== 'EXIF' && tag !== 'XMP ') chunks.push(buf.subarray(o, end));
    o = end;
  }
  const body = Buffer.concat(chunks);
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function prepare(buf, kind) {
  const lim = LIMITS[kind];
  if (!lim) throw bad('bad image');
  if (!Buffer.isBuffer(buf) || buf.length < 16) throw bad(`${kind} is not an image`);
  if (buf.length > lim.bytes) throw bad(`${kind} must be under ${lim.bytes === 1_000_000 ? '1 MB' : '256 KB'}`);
  const type = sniff(buf);
  if (!type) throw bad(`${kind} must be PNG, JPG, or WebP`);
  const size = type === 'png' ? pngSize(buf) : type === 'jpeg' ? jpegSize(buf) : webpSize(buf);
  if (size.w < 1 || size.h < 1 || size.w > lim.w || size.h > lim.h) throw bad(`${kind} must be at most ${lim.w}×${lim.h}`);
  const bytes = type === 'png' ? stripPng(buf) : type === 'jpeg' ? stripJpeg(buf) : stripWebp(buf);
  return { bytes, type: MIME[type] };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([head, data, sum]);
}
// Flat-color PNG. Used for the demo profile and tests. A solid image deflates to a few hundred bytes.
function solidPng(w, h, rgb) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { prepare, solidPng, sniff, LIMITS };
