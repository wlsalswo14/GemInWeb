// Generates extension/icons/icon{16,32,48,128}.png with zero dependencies (node:zlib).
// Usage: node extension/icons/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape in unit coordinates (0..1): rounded square with a blue→violet gradient,
// a white gem (diamond) in the middle, and a small terminal cursor bar.
function sample(u, v) {
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (dx * dx + dy * dy > r * r) return null;
  const t = (u + v) / 2;
  let col = [26 + (124 - 26) * t, 115 + (77 - 115) * t, 232 + (255 - 232) * t];
  // diamond: |x-cx|/w + |y-cy|/h <= 1
  const cx = 0.5, cy = 0.47, w = 0.27, h = 0.31;
  const d = Math.abs(u - cx) / w + Math.abs(v - cy) / h;
  if (d <= 1) {
    const facet = (u < cx) !== (v < cy - 0.08) ? 1 : 0.86;
    col = [255 * facet, 255 * facet, 255 * facet];
    if (v < cy - 0.08 && Math.abs(v - (cy - 0.08)) < 0.025) col = [210, 225, 255];
  }
  if (u > 0.36 && u < 0.64 && v > 0.84 && v < 0.89) col = [255, 255, 255];
  return col;
}

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0];
          gg += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(gg / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return png(size, buf);
}

for (const s of [16, 32, 48, 128]) {
  const out = join(here, `icon${s}.png`);
  writeFileSync(out, render(s));
  console.log('wrote', out);
}
