// Tiny QR code generator for short text such as UPI payment links.
// Byte mode, error correction level M, versions 1 to 6 (up to 106 bytes).
// Written for Hisaab and checked by decoding its output with an independent QR reader.

const VERSIONS = { // version: [total codewords, error-correction codewords per block, number of blocks]
  1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 1], 4: [100, 18, 2], 5: [134, 24, 2], 6: [172, 16, 4]
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

// ---- Reed-Solomon over GF(256) ----
const EXP = new Array(512), LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g; // highest degree first
}
function rsRemainder(data, n) {
  const gen = rsGenerator(n), rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift(); rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

function encodeData(bytes, version) {
  const [total, ecPer, blocks] = VERSIONS[version];
  const dataWords = total - ecPer * blocks;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, 8);
  bytes.forEach(b => push(b, 8));
  push(0, Math.min(4, dataWords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xEC; words.length < dataWords; pad ^= 0xEC ^ 0x11) words.push(pad);

  // split into blocks, add error correction, interleave
  const per = dataWords / blocks, dBlocks = [], eBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const d = words.slice(b * per, (b + 1) * per);
    dBlocks.push(d); eBlocks.push(rsRemainder(d, ecPer));
  }
  const out = [];
  for (let i = 0; i < per; i++) dBlocks.forEach(d => out.push(d[i]));
  for (let i = 0; i < ecPer; i++) eBlocks.forEach(e => out.push(e[i]));
  return out;
}

function buildMatrix(codewords, version, mask) {
  const size = 17 + 4 * version;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = ALIGN[version];
  if (ap.length) {
    const p = ap[1];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(p + dx, p + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // reserve format areas (real bits are drawn below)
  const drawFormat = m => {
    const data = m; // error correction level M has format bits 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  // place data bits in the zigzag order
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
  }
  // mask, then draw the real format bits
  const invert = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ][mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && invert(y, x)) mod[y][x] = !mod[y][x];
  drawFormat(mask);
  return mod;
}

// Simplified penalty score (runs, 2x2 blocks, dark balance) to pick a readable mask.
function penalty(m) {
  const n = m.length; let score = 0;
  const runs = get => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      }
    }
  };
  runs((a, b) => m[a][b]); runs((a, b) => m[b][a]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  const dark = m.flat().filter(Boolean).length, pct = dark * 100 / (n * n);
  return score + Math.floor(Math.abs(pct - 50) / 5) * 10;
}

/** Returns a square array of booleans (true = dark module), or null if the text is too long. */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  for (let v = 1; v <= 6; v++) {
    const [total, ecPer, blocks] = VERSIONS[v];
    if (4 + 8 + bytes.length * 8 > (total - ecPer * blocks) * 8) continue;
    const words = encodeData(bytes, v);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(words, v, mask), s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }
  return null;
}

/** Draws a QR code (with its quiet zone) on a canvas. Returns false if the text is too long. */
export function drawQr(canvas, text, px = 320) {
  const m = qrMatrix(text);
  if (!m) return false;
  const n = m.length, quiet = 4, scale = Math.max(3, Math.floor(px / (n + quiet * 2)));
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) c.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return true;
}
