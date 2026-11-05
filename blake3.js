// BLAKE3, the hash the Parano1d media service uses for native asset manifests.
// Zero dependencies: Node's crypto has no BLAKE3 and we will not add one to this repo.
// The tree layer (chunks > 1024 bytes, parent nodes) is included so this is not
// silently limited to small inputs; every branch below is covered by the vectors in
// test.js and by 17 live manifests re-hashed in scripts/check-metadata.mjs.
'use strict';

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const MSG = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8,
  3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1,
  10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6,
  12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4,
  9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7,
  11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13,
]);

const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;

const CHUNK_LEN = 1024;
const BLOCK_LEN = 64;
const OUT_LEN = 32;

function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

function g(s, a, b, c, d, mx, my) {
  s[a] = (s[a] + s[b] + mx) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

// One compression. cv is 8 words, block 16 words, counter, blockLen, flags.
function compress(cv, block, counter, blockLen, flags) {
  const s = new Uint32Array(16);
  s.set(cv, 0);
  s[8] = IV[0]; s[9] = IV[1]; s[10] = IV[2]; s[11] = IV[3];
  s[12] = counter & 0xffffffff;
  s[13] = Math.floor(counter / 0x100000000);
  s[14] = blockLen;
  s[15] = flags;
  const m = new Uint32Array(16);
  for (let r = 0; r < 7; r++) {
    for (let i = 0; i < 16; i++) m[i] = block[MSG[r * 16 + i]];
    g(s, 0, 4, 8, 12, m[0], m[1]);
    g(s, 1, 5, 9, 13, m[2], m[3]);
    g(s, 2, 6, 10, 14, m[4], m[5]);
    g(s, 3, 7, 11, 15, m[6], m[7]);
    g(s, 0, 5, 10, 15, m[8], m[9]);
    g(s, 1, 6, 11, 12, m[10], m[11]);
    g(s, 2, 7, 8, 13, m[12], m[13]);
    g(s, 3, 4, 9, 14, m[14], m[15]);
  }
  const out = new Uint32Array(16);
  for (let i = 0; i < 8; i++) { out[i] = s[i] ^ s[i + 8]; out[i + 8] = s[i + 8] ^ cv[i]; }
  return out;
}

// Little-endian words for one 64-byte block, zero padded past the end of the input.
function wordsFromBytes(bytes, start, len, out) {
  for (let i = 0; i < 16; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      const idx = i * 4 + k;
      const p = start + idx;
      if (idx < len && p < bytes.length) w |= bytes[p] << (8 * k);
    }
    out[i] = w >>> 0;
  }
  return out;
}

// Hash one chunk (<= 1024 bytes) and return its 8-word chaining value.
function chunkCv(cv, bytes, start, len, chunkCounter) {
  const block = new Uint32Array(16);
  const blocks = Math.max(1, Math.ceil(len / BLOCK_LEN));
  let cur = cv;
  for (let b = 0; b < blocks; b++) {
    const off = start + b * BLOCK_LEN;
    const blen = Math.min(BLOCK_LEN, len - b * BLOCK_LEN);
    wordsFromBytes(bytes, off, Math.max(blen, 0), block);
    const flags = (b === 0 ? CHUNK_START : 0) | (b === blocks - 1 ? CHUNK_END : 0);
    const out = compress(cur, block, chunkCounter, blen, flags);
    cur = out.slice(0, 8);
  }
  return cur;
}

function parentWords(left, right, out) {
  out.set(left, 0);
  out.set(right, 8);
  return out;
}

function parentCv(left, right, flags) {
  const block = new Uint32Array(16);
  parentWords(left, right, block);
  return compress(IV, block, 0, BLOCK_LEN, PARENT | flags).slice(0, 8);
}

function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// input: Buffer | Uint8Array | string. domain: optional byte prefix (the protocol's
// manifests are hashed as domain || canonical-bytes).
function blake3Bytes(input, domain) {
  let data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (domain) data = Buffer.concat([Buffer.from(domain), data]);
  const len = data.length;
  const key = IV;

  if (len <= CHUNK_LEN) {
    const cv = chunkCv(key, data, 0, len, 0);
    // root output: same chunk, ROOT flag set
    const block = new Uint32Array(16);
    const blocks = Math.max(1, Math.ceil(len / BLOCK_LEN));
    let cur = key;
    for (let b = 0; b < blocks; b++) {
      const off = b * BLOCK_LEN;
      const blen = Math.min(BLOCK_LEN, len - off);
      wordsFromBytes(data, off, Math.max(blen, 0), block);
      const flags = (b === 0 ? CHUNK_START : 0) | (b === blocks - 1 ? CHUNK_END : 0) | (b === blocks - 1 ? ROOT : 0);
      const words = compress(cur, block, 0, blen, flags);
      if (b === blocks - 1) return Buffer.from(new Uint8Array(words.buffer, 0, OUT_LEN));
      cur = words.slice(0, 8);
    }
    return Buffer.from(new Uint8Array(cv.buffer, 0, OUT_LEN));
  }

  // Multi-chunk: chunk CVs merge into complete subtrees by the popcount rule, but the
  // LAST chunk is deliberately left out of that merging -- the merge that consumes it is
  // the root, and only the root compression carries ROOT. Merging it eagerly (the obvious
  // reading of the rule) gives a valid chaining value with the wrong flag, which is a
  // different hash.
  const chunks = Math.ceil(len / CHUNK_LEN);
  const stack = [];
  for (let i = 0; i < chunks - 1; i++) {
    let cv = chunkCv(key, data, i * CHUNK_LEN, CHUNK_LEN, i);
    let total = i + 1;
    while ((total & 1) === 0) {
      cv = parentCv(stack.pop(), cv, 0);
      total >>= 1;
    }
    stack.push(cv);
  }
  const start = (chunks - 1) * CHUNK_LEN;
  let right = chunkCv(key, data, start, len - start, chunks - 1);
  while (stack.length) {
    const left = stack.pop();
    if (!stack.length) {
      const block = new Uint32Array(16);
      parentWords(left, right, block);
      const words = compress(IV, block, 0, BLOCK_LEN, PARENT | ROOT);
      return Buffer.from(new Uint8Array(words.buffer, 0, OUT_LEN));
    }
    right = parentCv(left, right, 0);
  }
  /* c8 ignore next */
  return Buffer.from(new Uint8Array(OUT_LEN));
}

function blake3Hex(input, domain) { return hex(blake3Bytes(input, domain)); }

module.exports = { blake3Hex, blake3Bytes };
