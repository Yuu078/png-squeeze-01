// png-squeeze-01: squeeze screenshots into the smallest lossless PNG.
//
// One self-contained program (Node 22, built-in modules only). For every
// instance under the input directory it decodes the stored RGBA screenshot,
// screens the lossless forms that can hold it (palette, grey, grey+alpha,
// RGB, RGBA, tRNS-keyed) against several per-row filter strategies with zlib,
// then writes the winner as a PNG in the checker's stated format (bit depth 8,
// not interlaced, only IHDR/PLTE/tRNS/IDAT/IEND, one zlib stream). The winning
// form's filtered data is then re-deflated by this file's own optimal-parse
// deflate (squeezeDeflate below); whichever stream is smaller is written.
// Every choice is a function of the pixels alone: no clock, no environment,
// no randomness, so two executions write the same bytes.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ CRC32 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function pngFile(width, height, colourType, plte, trns, idat) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = colourType;
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ------------------------------------------------------------- PNG decode */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('not a png');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  const plte = [];
  const trns = [];
  const idat = [];
  let idatLen = 0;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const len = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      bitDepth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new Error('interlaced input not supported');
    } else if (type === 'PLTE') {
      for (let i = 0; i + 2 < data.length; i += 3) plte.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'tRNS') {
      for (let i = 0; i < data.length; i++) trns.push(data[i]);
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += data.length;
    } else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error('colour type ' + colourType);
  const joined = new Uint8Array(idatLen);
  let off = 0;
  for (const part of idat) {
    joined.set(part, off);
    off += part.length;
  }
  const raw = inflateSync(joined);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const f = raw[rowAt];
    const row = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = row[i];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(a, b, c)) & 0xff;
      cur[i] = v;
    }
    for (let x = 0, s = 0, d = y * width * 4; x < width; x++, s += channels, d += 4) {
      if (colourType === 6) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = cur[s + 3];
      } else if (colourType === 2) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = 255;
      } else if (colourType === 0) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s]; rgba[d + 2] = cur[s]; rgba[d + 3] = 255;
      } else if (colourType === 4) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s]; rgba[d + 2] = cur[s]; rgba[d + 3] = cur[s + 1];
      } else {
        const p = plte[cur[s]] || [0, 0, 0];
        rgba[d] = p[0]; rgba[d + 1] = p[1]; rgba[d + 2] = p[2];
        rgba[d + 3] = cur[s] < trns.length ? trns[cur[s]] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, rgba };
}

/* --------------------------------------------------------------- analysis */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([c, count]) => ({
      r: (c >>> 24) & 0xff, g: (c >>> 16) & 0xff, b: (c >>> 8) & 0xff, a: c & 0xff, count,
    }));
  }
  return { opaque, grey, colours };
}

/** The single fully transparent colour keyable by tRNS, or null. */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/* ---------------------------------------------------------------- filters */
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let p = 0;
    if (type === 1) p = a;
    else if (type === 2) p = b;
    else if (type === 3) p = (a + b) >> 1;
    else p = paeth(a, b, c);
    out[i] = (cur[i] - p) & 0xff;
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const LOG2 = new Float64Array(8192);
for (let i = 1; i < LOG2.length; i++) LOG2[i] = Math.log2(i);

/** Zero-order entropy of a row, in bits: a cheap stand-in for its deflated size. */
function entropyBits(row, hist) {
  hist.fill(0);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let bits = 0;
  const n = row.length;
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    if (c) bits += c * (LOG2[n] - LOG2[c]);
  }
  return bits;
}

const PAIRS_SEEN = new Uint32Array(65536);
let pairsStamp = 0;

/** The fewest-distinct-pairs heuristic's cost for a filtered row. */
function pairsCost(row) {
  pairsStamp++;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const p = (row[i - 1] << 8) | row[i];
    if (PAIRS_SEEN[p] !== pairsStamp) {
      PAIRS_SEEN[p] = pairsStamp;
      n++;
    }
  }
  return n;
}

/**
 * Filter `samples` (height rows of width*bpp) into raw PNG scanline data.
 * strategy: 0..4 fixed filter, 'minsum' (least signed sum per row),
 * 'entropy' (least zero-order entropy per row).
 */
function filterData(samples, width, height, bpp, strategy) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const hist = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof strategy === 'number') {
      raw[at] = strategy;
      filterRowInto(strategy, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t]);
      const cost = strategy === 'minsum' ? signedSum(trials[t]) : strategy === 'pairs' ? pairsCost(trials[t]) : entropyBits(trials[t], hist);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

/* ------------------------------------------- optimal-parse deflate (own) */
// A zopfli-manner deflate: hash-chain match finding, then a shortest-path
// (optimal) parse under Huffman costs gathered from the data, iterated twice,
// emitted as dynamic- or fixed-Huffman blocks, whichever is smaller, inside a
// zlib stream. All budgets are counted in positions visited, never in time.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_SYM = new Uint16Array(259);
const LEN_EXT = new Uint8Array(259);
for (let s = 0; s < 29; s++) {
  const hi = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
  for (let l = LEN_BASE[s]; l <= hi && l < 259; l++) {
    LEN_SYM[l] = 257 + s;
    LEN_EXT[l] = LEN_EXTRA[s];
  }
}
const DIST_SYM = new Uint8Array(32769);
const DIST_EXT = new Uint8Array(32769);
for (let s = 0; s < 30; s++) {
  const hi = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
  for (let d = DIST_BASE[s]; d <= hi; d++) {
    DIST_SYM[d] = s;
    DIST_EXT[d] = DIST_EXTRA[s];
  }
}
// The distinct match lengths worth pricing in the parse: every length-code
// boundary, plus the longest length itself (added per position).
const LEN_STEPS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    b += a;
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  a %= 65521;
  b %= 65521;
  return ((b << 16) | a) >>> 0;
}

/** Length-limited Huffman code lengths from frequencies (package-merge). */
function huffmanLengths(freq, maxLen, alphabet) {
  const lengths = new Uint8Array(alphabet);
  const syms = [];
  for (let s = 0; s < alphabet; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Package-merge: work with (weight, symbols) packages over maxLen levels.
  const items = syms.map((s) => ({ w: freq[s], syms: [s] })).sort((x, y) => x.w - y.w);
  let level = items;
  const counts = new Map();
  for (let d = 1; d < maxLen; d++) {
    const packed = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      packed.push({ w: level[i].w + level[i + 1].w, syms: level[i].syms.concat(level[i + 1].syms) });
    }
    level = items.concat(packed).sort((x, y) => x.w - y.w);
    if (d === maxLen - 1) {
      const take = 2 * syms.length - 2;
      for (let i = 0; i < take && i < level.length; i++) {
        for (const s of level[i].syms) counts.set(s, (counts.get(s) || 0) + 1);
      }
    }
  }
  for (const s of syms) lengths[s] = counts.get(s) || maxLen;
  return lengths;
}

/** Canonical codes for a length table: returns [code, len] pairs per symbol. */
function canonicalCodes(lengths) {
  const maxLen = Math.max(...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
  const next = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s]) codes[s] = next[lengths[s]]++;
  }
  return codes;
}

function reverseBits(v, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (v & 1);
    v >>= 1;
  }
  return r;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.buf = 0;
    this.nbits = 0;
  }
  bits(value, count) {
    this.buf |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.buf & 0xff);
      this.buf >>= 8;
      this.nbits -= 8;
    }
  }
  huff(code, len) {
    this.bits(reverseBits(code, len), len);
  }
  align() {
    if (this.nbits > 0) {
      this.bytes.push(this.buf & 0xff);
      this.buf = 0;
      this.nbits = 0;
    }
  }
  byte(v) {
    this.bytes.push(v & 0xff);
  }
  finish() {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

const FIXED_LIT_LEN = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

/** Find the longest match at every position (hash chains, work-budgeted), plus
 * the longest match among near candidates (distance at most 2048): the parse
 * prices both, since a slightly shorter match at a much smaller distance
 * often costs fewer bits than the longest match far away. */
function findMatches(data, maxChain) {
  const n = data.length;
  const bestLen = new Uint16Array(n);
  const bestDist = new Uint32Array(n);
  const nearLen = new Uint16Array(n);
  const nearDist = new Uint32Array(n);
  const HBITS = 16;
  const head = new Int32Array(1 << HBITS).fill(-1);
  const prev = new Int32Array(n);
  const hashOf = (i) => (((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 0x9e3779b1) >>> (32 - HBITS);
  for (let i = 0; i + 2 < n; i++) {
    const h = hashOf(i);
    let cand = head[h];
    let bl = 0;
    let bd = 0;
    let nl = 0;
    let nd = 0;
    let tried = 0;
    let work = 0;
    const maxLen = Math.min(258, n - i);
    while (cand >= 0 && tried < maxChain) {
      const dist = i - cand;
      if (dist > 32768) break;
      // Cheap reject: beating either record requires the byte just past the
      // shorter record to match; if it does not, this candidate loses both.
      const near = dist <= 2048;
      const t = near ? Math.min(bl, nl) : bl;
      if (t < maxLen && data[cand + t] === data[i + t]) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        work += l + 1;
        if (l > bl || (l === bl && dist < bd)) {
          bl = l;
          bd = dist;
        }
        if (near && (l > nl || (l === nl && (nd === 0 || dist < nd)))) {
          nl = l;
          nd = dist;
        }
        if (bl >= maxLen && nl >= maxLen) break;
        // Work budget per position (counted in compared bytes, never time):
        // past it, further candidates almost never change the parse.
        if (work > 768) break;
      }
      cand = prev[cand];
      tried++;
    }
    if (bl >= 3) {
      bestLen[i] = bl;
      bestDist[i] = bd;
    }
    if (nl >= 3) {
      nearLen[i] = nl;
      nearDist[i] = nd;
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { bestLen, bestDist, nearLen, nearDist };
}

/** Greedy tokenisation for statistics: returns [litFreq(288), distFreq(30)]. */
function gatherStats(data, bestLen, bestDist, start, end) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  let i = start;
  while (i < end) {
    const l = Math.min(bestLen[i], end - i);
    if (l >= 3) {
      litFreq[LEN_SYM[l]]++;
      distFreq[DIST_SYM[bestDist[i]]]++;
      i += l;
    } else {
      litFreq[data[i]]++;
      i++;
    }
  }
  litFreq[256]++;
  return [litFreq, distFreq];
}

/**
 * Optimal parse of data[start..end) under the given per-symbol bit costs.
 * Returns the token list: [kind, a, b] with kind 0 = literal a, 1 = match
 * (length a, distance b).
 */
function optimalParse(data, bestLen, bestDist, nearLen, nearDist, start, end, litCost, lenCost, distCost) {
  const n = end - start;
  const cost = new Float64Array(n + 1);
  const pickLen = new Uint16Array(n + 1);
  const pickDist = new Uint32Array(n + 1);
  for (let i = n - 1; i >= 0; i--) {
    const pos = start + i;
    let best = litCost[data[pos]] + cost[i + 1];
    let bl = 0;
    let bd = 0;
    const room = n - i;
    for (let m = 0; m < 2; m++) {
      const ml = Math.min(m === 0 ? bestLen[pos] : nearLen[pos], room);
      if (ml < 3) continue;
      const dist = m === 0 ? bestDist[pos] : nearDist[pos];
      if (m === 1 && dist === bestDist[pos]) continue;
      const dc = distCost[dist];
      for (let s = 0; s < LEN_STEPS.length; s++) {
        const l = LEN_STEPS[s];
        if (l > ml) break;
        const c = lenCost[l] + dc + cost[i + l];
        if (c < best) {
          best = c;
          bl = l;
          bd = dist;
        }
      }
      if (ml >= 3 && LEN_SYM[ml] !== 0) {
        const c = lenCost[ml] + dc + cost[i + ml];
        if (c < best) {
          best = c;
          bl = ml;
          bd = dist;
        }
      }
    }
    cost[i] = best;
    pickLen[i] = bl;
    pickDist[i] = bd;
  }
  const tokens = [];
  let i = 0;
  while (i < n) {
    const l = pickLen[i];
    if (l === 0) {
      tokens.push(0, data[start + i], 0);
      i++;
    } else {
      tokens.push(1, l, pickDist[i]);
      i += l;
    }
  }
  return tokens;
}

function tokenCosts(litFreq, distFreq) {
  const litLen = huffmanLengths(litFreq, 15, 288);
  const distLen = huffmanLengths(distFreq, 15, 30);
  const litCost = new Float64Array(256);
  for (let s = 0; s < 256; s++) litCost[s] = litLen[s] || 30;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = (litLen[LEN_SYM[l]] || 30) + LEN_EXT[l];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distCost[d] = (distLen[DIST_SYM[d]] || 30) + DIST_EXT[d];
  return { litLen, distLen, litCost, lenCost, distCost };
}

function countTokens(tokens) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  for (let t = 0; t < tokens.length; t += 3) {
    if (tokens[t] === 0) litFreq[tokens[t + 1]]++;
    else {
      litFreq[LEN_SYM[tokens[t + 1]]]++;
      distFreq[DIST_SYM[tokens[t + 2]]]++;
    }
  }
  litFreq[256]++;
  return [litFreq, distFreq];
}

/** The RLE encoding of a dynamic header's code lengths. */
function encodeLengthsRLE(all) {
  // Returns {seq: [[sym, extra, extraBits]...], clFreq} for lengths `all`.
  const seq = [];
  const clFreq = new Float64Array(19);
  const push = (sym, extra, extraBits) => {
    seq.push(sym, extra, extraBits);
    clFreq[sym]++;
  };
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        push(18, take - 11, 7);
        r -= take;
      }
      if (r >= 3) push(17, r - 3, 3);
      else while (r-- > 0) push(0, 0, 0);
    } else {
      push(v, 0, 0);
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        push(16, take - 3, 2);
        r -= take;
      }
      while (r-- > 0) push(v, 0, 0);
    }
    i += run;
  }
  return { seq, clFreq };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Bits a dynamic block takes (header + tokens), or Infinity when invalid. */
function dynamicBlockBits(tokens, litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = [...litLen.subarray(0, hlit), ...distLen.subarray(0, hdist)];
  const { seq, clFreq } = encodeLengthsRLE(all);
  const clLen = huffmanLengths(clFreq, 7, 19);
  for (let s = 0; s < 19; s++) if (clFreq[s] > 0 && clLen[s] === 0) return Infinity;
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (let t = 0; t < seq.length; t += 3) bits += clLen[seq[t]] + seq[t + 2];
  for (let t = 0; t < tokens.length; t += 3) {
    if (tokens[t] === 0) bits += litLen[tokens[t + 1]];
    else {
      bits += litLen[LEN_SYM[tokens[t + 1]]] + LEN_EXT[tokens[t + 1]];
      bits += distLen[DIST_SYM[tokens[t + 2]]] + DIST_EXT[tokens[t + 2]];
    }
  }
  bits += litLen[256];
  return bits;
}

function fixedBlockBits(tokens) {
  let bits = 3 + FIXED_LIT_LEN[256];
  for (let t = 0; t < tokens.length; t += 3) {
    if (tokens[t] === 0) bits += FIXED_LIT_LEN[tokens[t + 1]];
    else {
      bits += FIXED_LIT_LEN[LEN_SYM[tokens[t + 1]]] + LEN_EXT[tokens[t + 1]];
      bits += 5 + DIST_EXT[tokens[t + 2]];
    }
  }
  return bits;
}

function writeBlock(w, tokens, litLen, distLen, dynamic, final) {
  w.bits(final ? 1 : 0, 1);
  w.bits(dynamic ? 2 : 1, 2);
  let useLit = litLen;
  let useDist = distLen;
  if (dynamic) {
    let hlit = 286;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const all = [...litLen.subarray(0, hlit), ...distLen.subarray(0, hdist)];
    const { seq, clFreq } = encodeLengthsRLE(all);
    const clLen = huffmanLengths(clFreq, 7, 19);
    const clCodes = canonicalCodes(clLen);
    let hclen = 19;
    while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
    w.bits(hlit - 257, 5);
    w.bits(hdist - 1, 5);
    w.bits(hclen - 4, 4);
    for (let i = 0; i < hclen; i++) w.bits(clLen[CL_ORDER[i]], 3);
    for (let t = 0; t < seq.length; t += 3) {
      w.huff(clCodes[seq[t]], clLen[seq[t]]);
      if (seq[t + 2]) w.bits(seq[t + 1], seq[t + 2]);
    }
  } else {
    useLit = FIXED_LIT_LEN;
    useDist = FIXED_DIST_LEN;
  }
  const litCodes = canonicalCodes(useLit);
  const distCodes = canonicalCodes(useDist);
  for (let t = 0; t < tokens.length; t += 3) {
    if (tokens[t] === 0) {
      const s = tokens[t + 1];
      w.huff(litCodes[s], useLit[s]);
    } else {
      const sym = LEN_SYM[tokens[t + 1]];
      w.huff(litCodes[sym], useLit[sym]);
      if (LEN_EXT[tokens[t + 1]]) w.bits(tokens[t + 1] - LEN_BASE[sym - 257], LEN_EXT[tokens[t + 1]]);
      const dsym = DIST_SYM[tokens[t + 2]];
      w.huff(distCodes[dsym], useDist[dsym]);
      if (DIST_EXT[tokens[t + 2]]) w.bits(tokens[t + 2] - DIST_BASE[dsym], DIST_EXT[tokens[t + 2]]);
    }
  }
  w.huff(litCodes[256], useLit[256]);
}

/**
 * Deflate `data` with the optimal parse, as a whole zlib stream. Falls back
 * to per-block fixed Huffman or stored blocks whenever those are smaller.
 */
function squeezeDeflate(data) {
  const n = data.length;
  const maxChain = n <= 1200000 ? 640 : n <= 2500000 ? 256 : 160;
  const { bestLen, bestDist, nearLen, nearDist } = findMatches(data, maxChain);
  const BLOCK = 786432;
  const w = new BitWriter();
  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK);
    const final = end === n;
    let [litFreq, distFreq] = gatherStats(data, bestLen, bestDist, start, end);
    let costs = tokenCosts(litFreq, distFreq);
    let tokens = optimalParse(data, bestLen, bestDist, nearLen, nearDist, start, end, costs.litCost, costs.lenCost, costs.distCost);
    [litFreq, distFreq] = countTokens(tokens);
    costs = tokenCosts(litFreq, distFreq);
    tokens = optimalParse(data, bestLen, bestDist, nearLen, nearDist, start, end, costs.litCost, costs.lenCost, costs.distCost);
    [litFreq, distFreq] = countTokens(tokens);
    costs = tokenCosts(litFreq, distFreq);
    tokens = optimalParse(data, bestLen, bestDist, nearLen, nearDist, start, end, costs.litCost, costs.lenCost, costs.distCost);
    [litFreq, distFreq] = countTokens(tokens);
    const emit = tokenCosts(litFreq, distFreq);
    const dynBits = dynamicBlockBits(tokens, emit.litLen, emit.distLen);
    const fixBits = fixedBlockBits(tokens);
    // Stored size for this block (byte-aligned, 5 bytes of header a 64KiB piece).
    const storedBits = Math.ceil((end - start) / 65535) * 5 * 8 + (end - start) * 8 + 3;
    if (storedBits < dynBits && storedBits < fixBits) {
      w.bits(final ? 1 : 0, 1);
      w.bits(0, 2);
      w.align();
      let at = start;
      while (at < end) {
        const take = Math.min(65535, end - at);
        w.byte(take & 0xff);
        w.byte((take >> 8) & 0xff);
        w.byte(~take & 0xff);
        w.byte(((~take) >> 8) & 0xff);
        for (let i = 0; i < take; i++) w.byte(data[at + i]);
        at += take;
      }
    } else if (dynBits <= fixBits) {
      writeBlock(w, tokens, emit.litLen, emit.distLen, true, final);
    } else {
      writeBlock(w, tokens, FIXED_LIT_LEN, FIXED_DIST_LEN, false, final);
    }
  }
  const body = w.finish();
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  const ad = adler32(data);
  out[body.length + 2] = (ad >>> 24) & 0xff;
  out[body.length + 3] = (ad >>> 16) & 0xff;
  out[body.length + 4] = (ad >>> 8) & 0xff;
  out[body.length + 5] = ad & 0xff;
  return out;
}

/* ---------------------------------------------------- forms and screening */
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.r - y.r || x.g - y.g || x.b - y.b || x.a - y.a;
    return y.count - x.count || x.r - y.r || x.g - y.g || x.b - y.b || x.a - y.a;
  });
  const index = new Map(entries.map((c, i) => [(c.r << 24) | (c.g << 16) | (c.b << 8) | c.a, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of((key >> 8) & 0xff, key & 0xff);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, (key >>> 16) & 0xff, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

const STRATEGIES = [0, 1, 2, 3, 4, 'minsum', 'pairs'];

function squeeze(image) {
  const { width, height, rgba } = image;
  // Screen every (form, filter strategy) with zlib at level 6 (fast; the
  // ranking it gives is the ranking the stronger compressors keep), then put
  // the winning filtered data through zlib 9 and the optimal-parse deflate
  // and keep the smallest stream.
  const screened = [];
  for (const form of formsOf(rgba)) {
    const chunkCost = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    for (const strategy of STRATEGIES) {
      const raw = filterData(form.samples, width, height, form.bpp, strategy);
      const stream = deflateSync(raw, { level: 6, memLevel: 8 });
      screened.push({ form, raw, total: stream.length + chunkCost });
    }
  }
  screened.sort((a, b) => a.total - b.total);
  let best = null;
  for (let k = 0; k < screened.length; k++) {
    const cand = screened[k];
    if (k > 0) break; // the winner only: a second strong pass costs more wall than it earns
    let idat = deflateSync(cand.raw, { level: 9, memLevel: 9 });
    try {
      const strong = squeezeDeflate(cand.raw);
      if (strong.length < idat.length) {
        const back = inflateSync(strong);
        let ok = back.length === cand.raw.length;
        for (let i = 0; ok && i < back.length; i++) if (back[i] !== cand.raw[i]) ok = false;
        if (ok) idat = strong;
      }
    } catch {
      // The zlib stream stands.
    }
    const chunkCost = (cand.form.plte ? 12 + cand.form.plte.length : 0) + (cand.form.trns ? 12 + cand.form.trns.length : 0);
    const total = idat.length + chunkCost;
    if (best === null || total < best.total) best = { form: cand.form, idat, total };
  }
  return pngFile(width, height, best.form.colourType, best.form.plte, best.form.trns, best.idat);
}

/* ------------------------------------------------------------------- main */
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image));
}
