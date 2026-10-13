import { describe, expect, it } from 'vitest';
import { paletteFor } from '../threads/brands.ts';
import { DEFAULT_SETTINGS, VISIBLE_DELTA, adjustPixels, analyzeColors, chartStats, cleanUp, mapToThreads, runPipeline, simplifyColors } from './pipeline.ts';
import type { SimplifySettings } from './pipeline.ts';
import type { PipelineSettings, Stage } from './pipeline.ts';

const palette = paletteFor('dmc');
const code = (index: number) => palette.entries[index].code;

/** RGBA image from a function of (x, y). */
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

/** Settings that differ from the defaults only where given. */
const settings = (change: { [K in keyof PipelineSettings]?: Partial<PipelineSettings[K]> } = {}): PipelineSettings => ({
  size: { ...DEFAULT_SETTINGS.size, ...change.size },
  adjust: { ...DEFAULT_SETTINGS.adjust, ...change.adjust },
  // Off unless a test asks for it: the tests of the later stages describe those stages alone.
  simplify: { ...DEFAULT_SETTINGS.simplify, enabled: false, ...change.simplify },
  colors: { ...DEFAULT_SETTINGS.colors, ...change.colors },
  cleanup: { ...DEFAULT_SETTINGS.cleanup, ...change.cleanup },
});

/** The chart a stage produces. */
function chart(rgba: Uint8ClampedArray, width: number, height: number, s: PipelineSettings, upTo: Stage = 'cleanup') {
  const result = runPipeline(rgba, width, height, palette, s, upTo);
  if (!('cells' in result)) throw new Error('expected a chart');
  return result;
}

const gradient = image(64, 64, (x, y) => [x * 4, y * 4, 128]);

describe('pipeline: colours', () => {
  it('flat colours go to the closest thread', () => {
    // Left half exactly DMC 310 black, right half exactly DMC 666 red.
    const rgba = image(8, 4, (x) => (x < 4 ? [12, 12, 12] : [201, 0, 35]));
    const { cells, stats } = chart(rgba, 8, 4, settings({ colors: { maxColors: 10 } }));
    expect(stats.colors).toBe(2);
    expect(code(cells[0])).toBe('310');
    expect(code(cells[7])).toBe('666');
  });

  it('uses about as many colours as asked for, and never more', () => {
    for (const maxColors of [2, 8, 24]) {
      const { cells, stats } = chart(gradient, 64, 64, settings({ colors: { maxColors } }));
      expect(stats.colors).toBeLessThanOrEqual(maxColors);
      expect(stats.colors).toBe(new Set(cells).size);
      expect(stats.colors).toBeGreaterThanOrEqual(maxColors * 0.8);
    }
  });

  it('more colours follow the image more closely', () => {
    const error = (maxColors: number) => {
      const { cells } = chart(gradient, 64, 64, settings({ colors: { maxColors } }));
      let sum = 0;
      for (let i = 0; i < cells.length; i++) {
        for (let c = 0; c < 3; c++) sum += Math.abs(palette.rgb[cells[i] * 3 + c] - gradient[i * 4 + c]);
      }
      return sum / cells.length;
    };
    expect(error(40)).toBeLessThan(error(4));
  });

  it('transparent pixels become empty cells, with or without dithering', () => {
    const rgba = image(4, 4, (x, y) => [200, 30, 30, x === y ? 0 : 255]);
    for (const dither of ['none', 'floyd'] as const) {
      const { cells, stats } = chart(rgba, 4, 4, settings({ colors: { maxColors: 5, dither } }));
      expect([cells[0], cells[5], cells[10], cells[15]]).toEqual([0, 0, 0, 0]);
      expect(cells[1]).not.toBe(0);
      expect(stats.stitches).toBe(12);
    }
  });

  it('a fully transparent image is an empty chart', () => {
    const { cells, stats } = chart(image(3, 3, () => [0, 0, 0, 0]), 3, 3, settings());
    expect(stats).toEqual({ stitches: 0, colors: 0, isolated: 0 });
    expect(cells.every((v) => v === 0)).toBe(true);
  });

  it('dithering mixes two threads to stand for a colour between them', () => {
    // A flat mid grey, with only black and white thread to work with.
    const rgba = image(40, 40, () => [128, 128, 128]);
    const black = palette.entries.findIndex((e) => e.code === '310');
    const white = palette.entries.findIndex((e) => e.code === 'BLANC');
    const map = (dither: 'none' | 'floyd') => mapToThreads(rgba, 40, 40, palette, [black, white], { maxColors: 2, dither, ditherAmount: 100 });
    // Without dithering every stitch gets the same thread.
    expect(new Set(map('none')).size).toBe(1);
    // With it both appear, in roughly equal parts, and scattered: that scatter is confetti.
    const mixed = map('floyd');
    const share = mixed.filter((v) => v === white).length / mixed.length;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.7);
    expect(chartStats(mixed, 40).isolated).toBeGreaterThan(100);
  });
});

describe('pipeline: adjust', () => {
  const pixels = image(4, 1, (x) => [[40, 40, 40], [120, 120, 120], [200, 200, 200], [200, 60, 60]][x] as [number, number, number]);
  const at = (rgba: Uint8ClampedArray, x: number) => [...rgba.slice(x * 4, x * 4 + 3)];

  it('leaves the image alone at zero, and never changes the original', () => {
    const before = new Uint8ClampedArray(pixels);
    expect(adjustPixels(pixels, { brightness: 0, contrast: 0, saturation: 0 })).toEqual(pixels);
    adjustPixels(pixels, { brightness: 50, contrast: 50, saturation: 50 });
    expect(pixels).toEqual(before);
  });

  it('brightness moves every pixel up or down', () => {
    expect(at(adjustPixels(pixels, { brightness: 30, contrast: 0, saturation: 0 }), 1)[0]).toBeGreaterThan(120);
    expect(at(adjustPixels(pixels, { brightness: -30, contrast: 0, saturation: 0 }), 1)[0]).toBeLessThan(120);
  });

  it('contrast pushes darks and lights apart', () => {
    const out = adjustPixels(pixels, { brightness: 0, contrast: 50, saturation: 0 });
    expect(at(out, 0)[0]).toBeLessThan(40);
    expect(at(out, 2)[0]).toBeGreaterThan(200);
  });

  it('saturation at -100 is grey, and positive makes colour stronger', () => {
    const grey = at(adjustPixels(pixels, { brightness: 0, contrast: 0, saturation: -100 }), 3);
    expect(new Set(grey).size).toBe(1);
    const vivid = at(adjustPixels(pixels, { brightness: 0, contrast: 0, saturation: 60 }), 3);
    expect(vivid[0] - vivid[1]).toBeGreaterThan(200 - 60);
  });
});

describe('pipeline: simplify', () => {
  const simple = (change: Partial<SimplifySettings> = {}): SimplifySettings => ({ ...DEFAULT_SETTINGS.simplify, ...change });
  const colorsOf = (rgba: Uint8ClampedArray) => {
    const found = new Set<number>();
    for (let p = 0; p < rgba.length; p += 4) if (rgba[p + 3] > 0) found.add((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
    return found;
  };
  const RED = 0xc80000;
  const BLUE = 0x0000c8;
  // Left half red, right half blue, with one near-red and one green pixel in the red half.
  const halves = image(20, 10, (x, y) => (x === 3 && y === 3 ? [190, 10, 10] : x === 6 && y === 6 ? [0, 200, 0] : x < 10 ? [200, 0, 0] : [0, 0, 200]));

  it('redraws the image with at most the number of colours asked for', () => {
    for (const colors of [2, 6, 20]) {
      const { pixels, palette } = simplifyColors(gradient, 64, 64, simple({ colors }));
      expect(colorsOf(pixels).size).toBeLessThanOrEqual(colors);
      expect(colorsOf(pixels).size).toBeGreaterThanOrEqual(colors * 0.7);
      expect(palette.length).toBe(colorsOf(pixels).size);
      expect(palette.reduce((sum, c) => sum + c.pixels, 0)).toBe(64 * 64);
    }
  });

  it('switched off, leaves the image as it is', () => {
    expect(simplifyColors(gradient, 64, 64, simple({ enabled: false })).pixels).toBe(gradient);
  });

  it('keeps transparent pixels transparent', () => {
    const rgba = image(4, 4, (x, y) => [200, 30, 30, x === y ? 0 : 255]);
    const { pixels } = simplifyColors(rgba, 4, 4, simple({ colors: 4 }));
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(255);
  });

  it('merges colours closer than the tolerance, keeping the one with more pixels', () => {
    const apart = simplifyColors(halves, 20, 10, simple({ colors: 4, method: 'median' }));
    expect(apart.palette.length).toBe(4);
    const merged = simplifyColors(halves, 20, 10, simple({ colors: 4, method: 'median', tolerance: 10 }));
    expect(merged.palette.length).toBe(3);
    // The near-red pixel is now plain red.
    expect([...merged.pixels.slice((3 * 20 + 3) * 4, (3 * 20 + 3) * 4 + 3)]).toEqual([...merged.pixels.slice(0, 3)]);
  });

  it('absorbs small patches into what surrounds them', () => {
    const { pixels, palette } = simplifyColors(halves, 20, 10, simple({ colors: 4, method: 'median', minRegion: 1 }));
    expect(palette.length).toBe(2);
    expect(colorsOf(pixels).size).toBe(2);
  });

  it('a pinned colour is in the result even when the image has little of it', () => {
    const green = 0x00c800;
    const without = simplifyColors(halves, 20, 10, simple({ colors: 2 }));
    expect(colorsOf(without.pixels).has(green)).toBe(false);
    const pinned = simplifyColors(halves, 20, 10, simple({ colors: 3, pinned: [green] }));
    expect(colorsOf(pinned.pixels).has(green)).toBe(true);
    expect(pinned.palette.find((c) => c.rgb === green)?.pinned).toBe(true);
    expect(pinned.palette.length).toBeLessThanOrEqual(3);
  });

  it('a removed colour gives its pixels to the closest one left; a merged one to the colour chosen', () => {
    const base = simplifyColors(halves, 20, 10, simple({ colors: 2 }));
    const [first, second] = base.palette.map((c) => c.rgb);
    const removed = simplifyColors(halves, 20, 10, simple({ colors: 2, removed: [second] }));
    expect([...colorsOf(removed.pixels)]).toEqual([first]);
    const merged = simplifyColors(halves, 20, 10, simple({ colors: 2, merged: [[first, second]] }));
    expect([...colorsOf(merged.pixels)]).toEqual([second]);
    // An edit that names a colour that is not there changes nothing.
    expect(simplifyColors(halves, 20, 10, simple({ colors: 2, removed: [0x123456] })).pixels).toEqual(base.pixels);
    expect(RED).not.toBe(BLUE);
  });

  it('smoothing flattens noise but keeps the edge between two areas', () => {
    const noisy = image(40, 20, (x, y) => {
      const n = ((x * 7 + y * 13) % 5) * 4;
      return x < 20 ? [60 + n, 60 + n, 60 + n] : [200 + n, 200 + n, 200 + n];
    });
    const { pixels } = simplifyColors(noisy, 40, 20, simple({ colors: 8, smooth: 6 }));
    expect(colorsOf(pixels).size).toBeLessThanOrEqual(4);
    expect(pixels[(10 * 40 + 19) * 4]).toBeLessThan(100);
    expect(pixels[(10 * 40 + 20) * 4]).toBeGreaterThan(180);
  });

  it('measures how the difference to the image falls as colours are added', () => {
    const { counts, error, visible, suggested } = analyzeColors(gradient, 64, 64, simple());
    expect(counts[0]).toBe(2);
    expect(counts.at(-1)).toBe(64);
    expect(error.length).toBe(counts.length);
    // More colours, less difference (k-means may wobble a little from one count to the next).
    expect(error[0]).toBeGreaterThan(error.at(-1)! * 3);
    for (let i = 4; i < error.length; i++) expect(error[i]).toBeLessThan(error[i - 4]);
    expect(visible[0]).toBeGreaterThan(0.9);
    expect(visible.at(-1)!).toBeLessThanOrEqual(visible[0]);
    // The suggestion is somewhere in the flat part: neither the fewest nor the most.
    expect(suggested).toBeGreaterThan(8);
    expect(suggested).toBeLessThan(64);
  });

  it('for an image of few colours, suggests just those', () => {
    const three = image(30, 30, (x) => (x < 10 ? [200, 0, 0] : x < 20 ? [0, 0, 200] : [240, 240, 240]));
    const { counts, error, suggested } = analyzeColors(three, 30, 30, simple());
    expect(suggested).toBe(3);
    expect(error[counts.indexOf(3)]).toBeLessThan(VISIBLE_DELTA);
  });

  it('the threads are then chosen from the simplified image', () => {
    const s = settings({ simplify: { enabled: true, colors: 6 }, colors: { maxColors: 30 } });
    expect(chart(gradient, 64, 64, s, 'colors').stats.colors).toBeLessThanOrEqual(6);
  });
});

describe('pipeline: cleanup', () => {
  // 6 x 4 chart, colour 1 everywhere except: a lone stitch of 2, a pair of 3, a block of 4.
  const W = 6;
  const make = () =>
    Uint16Array.from([
      1, 1, 1, 1, 4, 4,
      1, 2, 1, 1, 4, 4,
      1, 1, 1, 1, 4, 4,
      1, 3, 3, 1, 1, 1,
    ]);

  it('counts confetti as stitches with no neighbour of their colour', () => {
    expect(chartStats(make(), W)).toEqual({ stitches: 24, colors: 4, isolated: 1 });
  });

  it('absorbs groups up to the chosen size into what surrounds them', () => {
    const one = cleanUp(make(), W, 4, palette, { confetti: 1, minStitches: 0 });
    expect([one[7], one[19], one[4]]).toEqual([1, 3, 4]);
    const two = cleanUp(make(), W, 4, palette, { confetti: 2, minStitches: 0 });
    expect([two[7], two[19], two[20], two[4]]).toEqual([1, 1, 1, 4]);
    expect(chartStats(two, W).isolated).toBe(0);
  });

  it('leaves a lone stitch on empty fabric alone', () => {
    const cells = Uint16Array.from([0, 0, 0, 0, 5, 0, 0, 0, 0]);
    expect(cleanUp(cells, 3, 3, palette, { confetti: 3, minStitches: 0 })).toEqual(cells);
  });

  it('merges colours with too few stitches into the closest remaining colour', () => {
    const black = palette.entries.findIndex((e) => e.code === '310');
    const nearBlack = palette.entries.findIndex((e) => e.code === '3799');
    const red = palette.entries.findIndex((e) => e.code === '666');
    const cells = new Uint16Array(30).fill(black);
    cells.fill(red, 10, 20);
    cells[0] = nearBlack;
    const out = cleanUp(cells, 6, 5, palette, { confetti: 0, minStitches: 3 });
    expect(out[0]).toBe(black);
    expect(chartStats(out, 6).colors).toBe(2);
    expect(cells[0]).toBe(nearBlack); // the input is not modified
  });

  it('on a real conversion, leaves no confetti and no colour under the minimum', () => {
    // A dithered gradient is confetti all over.
    const s = settings({ colors: { maxColors: 24, dither: 'floyd', ditherAmount: 100 } });
    const before = chart(gradient, 64, 64, s, 'colors');
    expect(before.stats.isolated).toBeGreaterThan(200);
    const cleaned = cleanUp(before.cells, 64, 64, palette, { confetti: 1, minStitches: 30 });
    const stats = chartStats(cleaned, 64);
    expect(stats.isolated).toBe(0);
    expect(stats.stitches).toBe(before.stats.stitches);
    const counts = new Map<number, number>();
    for (const v of cleaned) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(Math.min(...counts.values())).toBeGreaterThanOrEqual(30);
    // Bigger groups: nothing of 3 stitches or fewer is left either.
    const groups = cleanUp(before.cells, 64, 64, palette, { confetti: 3, minStitches: 0 });
    expect(chartStats(groups, 64).isolated).toBe(0);
    expect(chartStats(groups, 64).colors).toBeLessThanOrEqual(before.stats.colors);
  });

  it('does not drag colours sideways through a noisy area', () => {
    // Two flat halves, top and bottom, with a band of loose stitches of many colours between them.
    const top = palette.entries.findIndex((e) => e.code === '310');
    const bottom = palette.entries.findIndex((e) => e.code === 'BLANC');
    const noise = ['666', '700', '797', '972', '553', '3799', '415'].map((c) => palette.entries.findIndex((e) => e.code === c));
    const w = 40;
    const cells = new Uint16Array(w * 12);
    for (let i = 0; i < cells.length; i++) {
      const y = Math.floor(i / w);
      cells[i] = y < 5 ? top : y > 6 ? bottom : noise[(i * 3 + y * 5) % noise.length];
    }
    const out = cleanUp(cells, w, 12, palette, { confetti: 1, minStitches: 0 });
    // Each row of the band joins the half it touches: nothing of the band's colours runs along it.
    for (let x = 0; x < w; x++) {
      expect(out[5 * w + x]).toBe(top);
      expect(out[6 * w + x]).toBe(bottom);
    }
  });

  it('between areas that touch a stitch equally, picks the closest colour', () => {
    const black = palette.entries.findIndex((e) => e.code === '310');
    const white = palette.entries.findIndex((e) => e.code === 'BLANC');
    const nearBlack = palette.entries.findIndex((e) => e.code === '3799');
    // White on the left (visited first), black on the right, a dark grey stitch between them.
    const cells = Uint16Array.from([white, white, nearBlack, black, black]);
    const out = cleanUp(cells, 5, 1, palette, { confetti: 1, minStitches: 0 });
    expect(out[2]).toBe(black);
  });

  it('does nothing when switched off', () => {
    expect(cleanUp(make(), W, 4, palette, { confetti: 0, minStitches: 0 })).toEqual(make());
  });
});

describe('pipeline: stages', () => {
  it('stops after the stage asked for', () => {
    const s = settings({ adjust: { brightness: 40 }, cleanup: { confetti: 4 }, colors: { dither: 'floyd' } });
    const size = runPipeline(gradient, 64, 64, palette, s, 'size');
    const adjust = runPipeline(gradient, 64, 64, palette, s, 'adjust');
    expect('pixels' in size && size.pixels).toEqual(gradient);
    expect('pixels' in adjust && adjust.pixels[0]).toBeGreaterThan(gradient[0]);
    const colors = chart(gradient, 64, 64, s, 'colors');
    const cleanup = chart(gradient, 64, 64, s, 'cleanup');
    expect(cleanup.stats.isolated).toBeLessThan(colors.stats.isolated);
  });
});
