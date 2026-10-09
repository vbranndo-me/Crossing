// Generates the synthetic test images in fixtures/images/. Real photos (photo-*.jpg) are never touched.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { rng } from '../src/core/rng.ts';
import { ROOT } from './lib.ts';

const SIZE = 1000;

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function image(fn: (x: number, y: number, out: Uint8Array, o: number) => void): Uint8Array {
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0, o = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++, o += 3) fn(x, y, rgb, o);
  return rgb;
}

const rand = rng(2024);
const flatColors = Array.from({ length: 8 }, () => [rand() * 256, rand() * 256, rand() * 256]);

export const FIXTURES: Record<string, Uint8Array> = {
  // Smooth gradient: hue-like sweep horizontally, dark to light vertically.
  gradient: image((x, y, out, o) => {
    const u = x / (SIZE - 1);
    const v = y / (SIZE - 1);
    out[o] = 255 * u * (0.3 + 0.7 * v);
    out[o + 1] = 255 * (1 - u) * (0.3 + 0.7 * v);
    out[o + 2] = 255 * v;
  }),
  // High-entropy noise: every pixel an independent random colour (worst case for caching).
  noise: image((_x, _y, out, o) => {
    out[o] = rand() * 256;
    out[o + 1] = rand() * 256;
    out[o + 2] = rand() * 256;
  }),
  // Eight flat colours in large blocks (best case).
  flat: image((x, y, out, o) => {
    const c = flatColors[(Math.floor(x / 125) + Math.floor(y / 250) * 3) % 8];
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
  }),
};

const dir = resolve(ROOT, 'fixtures/images');
mkdirSync(dir, { recursive: true });
for (const [name, rgb] of Object.entries(FIXTURES)) {
  writeFileSync(resolve(dir, `${name}.png`), png(SIZE, SIZE, rgb));
  console.log(`wrote fixtures/images/${name}.png`);
}
