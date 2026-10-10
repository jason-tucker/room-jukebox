// Generates build/icon.png (512x512) and build/icon.ico (16..256) without dependencies:
// a rounded square with a beamed music note, rasterised with 4x4 supersampling.
// Usage (from apps/desktop): node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const BG_TOP = [0x5b, 0x4b, 0xe6];
const BG_BOTTOM = [0x2f, 0x6f, 0xe0];
const NOTE = [0xff, 0xff, 0xff];

function inRoundedSquare(x, y) {
  const m = 0.04;
  const r = 0.2;
  if (x < m || x > 1 - m || y < m || y > 1 - m) return false;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r);
  const cy = Math.min(Math.max(y, m + r), 1 - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inEllipse(x, y, cx, cy, rx, ry, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
}

const heads = [
  { cx: 0.35, cy: 0.71 },
  { cx: 0.66, cy: 0.65 },
];
const RX = 0.115;
const RY = 0.082;
const STEM_W = 0.045;
const BEAM = { x0: 0.35 + 0.065, y0: 0.24, x1: 0.66 + 0.065 + STEM_W, y1: 0.18, h: 0.085 };
const beamTop = (x) => BEAM.y0 + ((BEAM.y1 - BEAM.y0) * (x - BEAM.x0)) / (BEAM.x1 - BEAM.x0);

function inNote(x, y) {
  for (const h of heads) {
    if (inEllipse(x, y, h.cx, h.cy, RX, RY, -0.35)) return true;
    const sx = h.cx + 0.065;
    if (x >= sx && x <= sx + STEM_W && y >= beamTop(x) && y <= h.cy) return true;
  }
  if (x >= BEAM.x0 && x <= BEAM.x1) {
    const top = beamTop(x);
    if (y >= top && y <= top + BEAM.h) return true;
  }
  return false;
}

/** RGBA pixels, row-major top-down. */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      let bg = 0;
      let note = 0;
      for (let a = 0; a < ss; a += 1) {
        for (let b = 0; b < ss; b += 1) {
          const x = (i + (a + 0.5) / ss) / size;
          const y = (j + (b + 0.5) / ss) / size;
          if (!inRoundedSquare(x, y)) continue;
          if (inNote(x, y)) note += 1;
          else bg += 1;
        }
      }
      const n = ss * ss;
      const cover = (bg + note) / n;
      const t = j / size;
      const base = BG_TOP.map((c, k) => c + (BG_BOTTOM[k] - c) * t);
      const mix = bg + note === 0 ? 0 : note / (bg + note);
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k += 1) px[o + k] = Math.round(base[k] * (1 - mix) + NOTE[k] * mix);
      px[o + 3] = Math.round(cover * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j += 1) {
    raw[j * (size * 4 + 1)] = 0;
    px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 32-bit BMP (DIB) icon image: BGRA bottom-up plus an all-zero AND mask. */
function dib(size) {
  const px = render(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskRow = Math.ceil(size / 32) * 4;
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const s = (j * size + i) * 4;
      const d = ((size - 1 - j) * size + i) * 4;
      pixels[d] = px[s + 2];
      pixels[d + 1] = px[s + 1];
      pixels[d + 2] = px[s];
      pixels[d + 3] = px[s + 3];
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(sizes) {
  const images = sizes.map((s) => (s >= 256 ? png(s) : dib(s)));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, k) => {
    const e = 6 + 16 * k;
    dir[e] = s >= 256 ? 0 : s;
    dir[e + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[k].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[k].length;
  });
  return Buffer.concat([dir, ...images]);
}

writeFileSync(new URL('../build/icon.png', import.meta.url), png(512));
writeFileSync(new URL('../build/icon.ico', import.meta.url), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote build/icon.png and build/icon.ico');
