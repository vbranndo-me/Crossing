import { describe, expect, it } from 'vitest';
import { pixelOE } from './pixeloe.ts';
import { resample } from './resample.ts';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number?]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      rgba.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return rgba;
}
/** Darkest and brightest red value in an RGBA image. */
const range = (rgba: Uint8ClampedArray) => {
  let min = 255;
  let max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    min = Math.min(min, rgba[i]);
    max = Math.max(max, rgba[i]);
  }
  return { min, max };
};

describe('PixelOE', () => {
  it('returns the size asked for', () => {
    const src = image(120, 90, (x, y) => [x * 2, y * 2, 100]);
    expect(pixelOE(src, 120, 90, 24, 18, { thickness: 2 }).length).toBe(24 * 18 * 4);
    expect(pixelOE(src, 120, 90, 24, 18, { thickness: 0 }).length).toBe(24 * 18 * 4);
  });

  it('leaves a flat colour as it is', () => {
    const src = image(64, 64, () => [180, 90, 40]);
    const out = pixelOE(src, 64, 64, 16, 16, { thickness: 2 });
    for (let i = 0; i < out.length; i += 4) {
      expect(Math.abs(out[i] - 180)).toBeLessThanOrEqual(2);
      expect(Math.abs(out[i + 1] - 90)).toBeLessThanOrEqual(2);
      expect(Math.abs(out[i + 2] - 40)).toBeLessThanOrEqual(2);
      expect(out[i + 3]).toBe(255);
    }
  });

  it('keeps a thin dark line that plain downscaling washes out', () => {
    // A 2-pixel black line on white, shrunk 10 times: averaged, it is a faint grey.
    const src = image(200, 200, (x) => (x === 100 || x === 101 ? [0, 0, 0] : [255, 255, 255]));
    const averaged = range(resample(src, 200, 200, 20, 20, 'bilinear'));
    expect(averaged.min).toBeGreaterThan(170);
    const kept = range(pixelOE(src, 200, 200, 20, 20, { thickness: 2 }));
    expect(kept.min).toBeLessThan(averaged.min - 60); // clearly darker than the average, i.e. still a line
    expect(kept.max).toBeGreaterThan(230); // and the background is still white
    // Without the outline expansion the line is a minority in its block and is dropped.
    expect(range(pixelOE(src, 200, 200, 20, 20, { thickness: 0 })).min).toBeGreaterThan(230);
  });

  it('keeps a thin bright line on a dark background too', () => {
    // Three pixels of white in every ten rows' worth of output pixel: a dim grey when averaged.
    const src = image(200, 200, (_x, y) => (y >= 60 && y <= 62 ? [255, 255, 255] : [20, 20, 20]));
    const averaged = range(resample(src, 200, 200, 20, 20, 'bilinear'));
    expect(averaged.max).toBeLessThan(120);
    expect(range(pixelOE(src, 200, 200, 20, 20, { thickness: 2 })).max).toBeGreaterThan(averaged.max + 60);
  });

  it('carries transparency through', () => {
    const src = image(80, 80, (x) => [200, 50, 50, x < 40 ? 255 : 0]);
    const out = pixelOE(src, 80, 80, 8, 8, { thickness: 1 });
    expect(out[3]).toBe(255);
    expect(out[7 * 4 + 3]).toBe(0);
  });

  it('handles a chart-sized image in reasonable time', () => {
    const src = image(800, 600, (x, y) => [(x * 7) % 256, (y * 5) % 256, (x + y) % 256]);
    const t0 = performance.now();
    pixelOE(src, 800, 600, 150, 112, { thickness: 2 });
    const ms = performance.now() - t0;
    console.log(`PixelOE 150 x 112: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(15_000);
  });
});
