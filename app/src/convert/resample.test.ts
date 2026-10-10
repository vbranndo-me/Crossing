import { describe, expect, it } from 'vitest';
import { SAMPLINGS, cropFor, resample } from './resample.ts';

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
const at = (rgba: Uint8ClampedArray, width: number, x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('resample', () => {
  it('returns the size asked for, with every method, shrinking or enlarging', () => {
    const src = image(30, 20, (x, y) => [x * 8, y * 12, 100]);
    for (const sampling of SAMPLINGS) {
      expect(resample(src, 30, 20, 7, 5, sampling).length).toBe(7 * 5 * 4);
      expect(resample(src, 30, 20, 60, 45, sampling).length).toBe(60 * 45 * 4);
    }
  });

  it('a flat colour stays exactly that colour', () => {
    const src = image(40, 40, () => [200, 100, 50]);
    for (const sampling of SAMPLINGS) {
      const out = resample(src, 40, 40, 9, 13, sampling);
      for (let i = 0; i < out.length; i += 4) expect([...out.slice(i, i + 4)]).toEqual([200, 100, 50, 255]);
    }
  });

  it('the same size gives the same image', () => {
    const src = image(12, 9, (x, y) => [x * 20, y * 25, (x * y) % 255]);
    for (const sampling of SAMPLINGS) expect(resample(src, 12, 9, 12, 9, sampling)).toEqual(src);
  });

  it('nearest keeps only colours that are in the image; the others blend', () => {
    // Black and white stripes one pixel wide, shrunk to a quarter.
    const src = image(64, 8, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]));
    // Red channel of the stitches away from the left and right edges (where a kernel is cut short).
    const values = (sampling: (typeof SAMPLINGS)[number]) => {
      const out = resample(src, 64, 8, 16, 2, sampling);
      const inner = new Set<number>();
      for (let y = 0; y < 2; y++) for (let x = 3; x < 13; x++) inner.add(out[(y * 16 + x) * 4]);
      return inner;
    };
    expect([...values('nearest')].every((v) => v === 0 || v === 255)).toBe(true);
    // Every stitch covers as much black as white: mid grey.
    for (const sampling of ['bilinear', 'bicubic', 'lanczos'] as const) {
      for (const v of values(sampling)) expect(Math.abs(v - 127.5)).toBeLessThan(3);
    }
  });

  it('shrinking averages all the pixels a stitch covers, not just a few', () => {
    // One bright pixel in every 8 x 8 block: skipped entirely by point sampling, a faint lift when averaged.
    const src = image(64, 64, (x, y) => (x % 8 === 3 && y % 8 === 3 ? [255, 255, 255] : [0, 0, 0]));
    expect(Math.max(...resample(src, 64, 64, 8, 8, 'nearest'))).toBe(255); // alpha only
    expect(resample(src, 64, 64, 8, 8, 'nearest')[0]).toBe(0);
    const averaged = resample(src, 64, 64, 8, 8, 'bilinear');
    expect(averaged[0]).toBeGreaterThan(0);
    expect(averaged[0]).toBeLessThan(40);
  });

  it('sharper methods keep an edge steeper', () => {
    const src = image(80, 4, (x) => (x < 40 ? [0, 0, 0] : [255, 255, 255]));
    const edge = (sampling: (typeof SAMPLINGS)[number]) => {
      const out = resample(src, 80, 4, 200, 4, sampling);
      // How many output pixels are neither black nor white.
      let between = 0;
      for (let x = 0; x < 200; x++) if (out[x * 4] > 8 && out[x * 4] < 247) between++;
      return between;
    };
    expect(edge('nearest')).toBe(0);
    expect(edge('bicubic')).toBeLessThanOrEqual(edge('bilinear'));
  });

  it('transparent pixels do not tint their neighbours', () => {
    // Opaque red next to fully transparent green.
    const src = image(8, 2, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    const out = resample(src, 8, 2, 2, 1, 'bilinear');
    expect(at(out, 2, 0, 0).slice(0, 3)).toEqual([255, 0, 0]);
    expect(at(out, 2, 1, 0)[3]).toBeLessThan(128);
    expect(at(out, 2, 1, 0)[1]).toBeLessThan(40); // whatever shows there is red, not the hidden green
  });
});

describe('cropFor', () => {
  it('is the whole image when the proportions match', () => {
    expect(cropFor(600, 400, 150, 100, { x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0, width: 600, height: 400 });
  });

  it('cuts the sides for a narrower chart, and slides with the position', () => {
    // A square chart from a 600 x 400 picture: 400 x 400, with 200 pixels of room sideways.
    expect(cropFor(600, 400, 100, 100, { x: 0.5, y: 0.5 })).toEqual({ x: 100, y: 0, width: 400, height: 400 });
    expect(cropFor(600, 400, 100, 100, { x: 0, y: 0.5 })).toMatchObject({ x: 0 });
    expect(cropFor(600, 400, 100, 100, { x: 1, y: 0.5 })).toMatchObject({ x: 200 });
  });

  it('cuts top and bottom for a wider chart', () => {
    expect(cropFor(600, 400, 300, 100, { x: 0.5, y: 1 })).toEqual({ x: 0, y: 200, width: 600, height: 200 });
  });
});
