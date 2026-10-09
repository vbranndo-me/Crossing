import { describe, expect, it } from 'vitest';
import { ciede2000, srgbToLab } from './color.ts';
import { convert, meanDeltaE } from './convert.ts';
import { createGrid, floodFill } from './grid.ts';
import { ObjectHistory, PackedHistory, SnapshotHistory, setCell } from './history.ts';
import type { History } from './history.ts';
import { makePalette } from './palette.ts';
import { rng } from './rng.ts';

describe('color', () => {
  it('matches the Sharma et al. CIEDE2000 reference pairs', () => {
    const pairs: number[][] = [
      [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
      [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
      [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
      [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
      [50, 2.5, 0, 50, 0, -2.5, 4.3065],
      [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
      [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
    ];
    for (const [L1, a1, b1, L2, a2, b2, want] of pairs) {
      expect(ciede2000(L1, a1, b1, L2, a2, b2)).toBeCloseTo(want, 4);
      expect(ciede2000(L2, a2, b2, L1, a1, b1)).toBeCloseTo(want, 4);
    }
  });

  it('converts sRGB to Lab', () => {
    const out = [0, 0, 0];
    srgbToLab(255, 255, 255, out);
    expect(out[0]).toBeCloseTo(100, 2);
    expect(Math.abs(out[1]) + Math.abs(out[2])).toBeLessThan(0.02);
    srgbToLab(255, 0, 0, out);
    expect(out[0]).toBeCloseTo(53.24, 1);
    expect(out[1]).toBeCloseTo(80.09, 1);
    expect(out[2]).toBeCloseTo(67.2, 1);
  });
});

describe('history', () => {
  const kinds: [string, (g: ReturnType<typeof createGrid>) => History][] = [
    ['packed', () => new PackedHistory()],
    ['object', () => new ObjectHistory()],
    ['snapshot', (g) => new SnapshotHistory(g)],
  ];
  for (const [name, make] of kinds) {
    it(`${name}: undo and redo restore the grid`, () => {
      const grid = createGrid(40, 30);
      const history = make(grid);
      const rand = rng(3);
      const states = [grid.cells.slice()];
      for (let k = 0; k < 60; k++) {
        const index = Math.floor(rand() * grid.cells.length);
        const value = 1 + Math.floor(rand() * 5);
        if (k % 6 === 5) {
          const f = floodFill(grid, index, value, 500);
          if (f.count === 0) continue;
          history.push(grid, { runs: f.runs, count: f.count, prev: f.prev, next: value });
        } else {
          history.push(grid, setCell(grid, index, value));
        }
        states.push(grid.cells.slice());
      }
      for (let k = states.length - 2; k >= 0; k--) {
        expect(history.undo(grid)).toBe(true);
        expect(grid.cells).toEqual(states[k]);
      }
      expect(history.undo(grid)).toBe(false);
      for (let k = 1; k < states.length; k++) {
        expect(history.redo(grid)).toBe(true);
        expect(grid.cells).toEqual(states[k]);
      }
      expect(history.redo(grid)).toBe(false);
    });
  }

  it('flood fill respects the cell cap', () => {
    const grid = createGrid(100, 100);
    const f = floodFill(grid, 5050, 3, 5000);
    expect(f.count).toBe(5000);
    expect(grid.cells.filter((v) => v === 3).length).toBe(5000);
  });
});

describe('convert', () => {
  const pal = makePalette(60);
  const w = 32;
  const h = 32;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rand = rng(9);
  for (let i = 0; i < w * h; i++) {
    // Pixels are exact palette colours, so a correct match has deltaE 0.
    const e = pal.entries[1 + Math.floor(rand() * 8)];
    rgba.set([e.rgb[0], e.rgb[1], e.rgb[2], 255], i * 4);
  }

  it('v1 finds the exact palette colours', () => {
    const r = convert(rgba, w, h, pal, { variant: 'v1' });
    expect(meanDeltaE(rgba, w, h, r.cells, pal)).toBeCloseTo(0, 6);
  });

  it('v2, v3 and dithering stay close to v1', () => {
    for (const opts of [
      { variant: 'v2' as const },
      { variant: 'v3' as const, n: 16 },
      { variant: 'v3' as const, n: 16, quantizer: 'kmeans' as const },
      { variant: 'v3' as const, n: 16, dither: true },
    ]) {
      const r = convert(rgba, w, h, pal, opts);
      expect(meanDeltaE(rgba, w, h, r.cells, pal)).toBeLessThan(3);
    }
  });
});
