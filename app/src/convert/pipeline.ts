import { ciede2000, srgbToLab } from '../core/color.ts';
import type { Palette } from '../core/palette.ts';
import { pixelOE } from './pixeloe.ts';
import { resample } from './resample.ts';
import type { Sampling } from './resample.ts';

/**
 * Image -> chart conversion, as a chain of stages. Each stage is a function in this file and has
 * its own settings, so one can be refined without touching the others:
 *
 *   size     the image scaled to one pixel per stitch        sizeImage
 *   adjust   brightness, contrast, saturation                adjustPixels
 *   colors   pick the threads, then give every stitch one    chooseThreads + mapToThreads
 *   cleanup  merge rare colours, remove confetti             cleanUp
 *
 * Everything here is plain computation on arrays, so it runs the same in a worker or in tests.
 */
export const STAGES = ['size', 'adjust', 'colors', 'cleanup'] as const;
export type Stage = (typeof STAGES)[number];

/** How the image is brought down to one pixel per stitch: a resampling kernel, or PixelOE. */
export const SIZE_METHODS = ['nearest', 'bilinear', 'bicubic', 'lanczos', 'pixeloe'] as const;
export type SizeMethod = (typeof SIZE_METHODS)[number];

export interface SizeSettings {
  method: SizeMethod;
  /** PixelOE only: how far outlines are expanded before downscaling, 0 to 4. */
  thickness: number;
}

export interface AdjustSettings {
  /** Each from -100 to 100; 0 leaves the image as it is. */
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface ColorSettings {
  /** Upper limit on the number of thread colours. */
  maxColors: number;
  /** How stitches are assigned: each to its closest thread, or with error diffusion (Floyd-Steinberg). */
  dither: 'none' | 'floyd';
  /** 0 to 100: how much of the error is passed on when dithering. */
  ditherAmount: number;
}

export interface CleanupSettings {
  /** Groups of up to this many connected stitches of one colour are absorbed by their surroundings. 0 = off. */
  confetti: number;
  /** Colours with fewer stitches than this are replaced by the closest remaining colour. 0 = off. */
  minStitches: number;
}

export interface PipelineSettings {
  size: SizeSettings;
  adjust: AdjustSettings;
  colors: ColorSettings;
  cleanup: CleanupSettings;
}

export interface ChartStats {
  /** Cells that have a stitch. */
  stitches: number;
  /** Distinct thread colours. */
  colors: number;
  /** "Confetti": stitches with no neighbour (up, down, left, right) of the same colour. */
  isolated: number;
}

export const MIN_COLORS = 2;
export const MAX_COLORS = 120;
export const MAX_CONFETTI = 8;
export const MAX_MIN_STITCHES = 200;

export const DEFAULT_SETTINGS: PipelineSettings = {
  size: { method: 'lanczos', thickness: 2 },
  adjust: { brightness: 0, contrast: 0, saturation: 0 },
  colors: { maxColors: 30, dither: 'none', ditherAmount: 75 },
  cleanup: { confetti: 0, minStitches: 0 },
};

/** Pixels are grouped by colour at 5 bits per channel: 32,768 buckets, however large the image. */
const BUCKETS = 32768;
/** Below this alpha a pixel is "no stitch". */
const OPAQUE = 128;
const KMEANS_ROUNDS = 8;
/** How many times more colours than asked for the image may be reduced to, looking for enough threads. */
const MAX_OVERSAMPLE = 4;
const CLEANUP_ROUNDS = 12;

const bucketOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const scratch = new Float64Array(3);

// ---------------------------------------------------------------- size

/** Stage "size": RGBA pixels of `width` x `height` (the part of the picture to use) scaled to the chart's size. */
export function sizeImage(pixels: Uint8ClampedArray, width: number, height: number, toWidth: number, toHeight: number, settings: SizeSettings): Uint8ClampedArray {
  if (settings.method === 'pixeloe') return pixelOE(pixels, width, height, toWidth, toHeight, { thickness: settings.thickness });
  return resample(pixels, width, height, toWidth, toHeight, settings.method satisfies Sampling);
}

// ---------------------------------------------------------------- adjust

/** Stage "adjust": a copy of the pixels with brightness, contrast and saturation applied. */
export function adjustPixels(rgba: Uint8ClampedArray, settings: AdjustSettings): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const { brightness, contrast, saturation } = settings;
  if (brightness === 0 && contrast === 0 && saturation === 0) return out;
  // Brightness shifts every channel; contrast stretches them away from (or towards) mid grey.
  const c = contrast * 1.6;
  const stretch = (259 * (c + 255)) / (255 * (259 - c));
  const curve = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) curve[v] = stretch * (v + brightness * 1.27 - 128) + 128;
  // Saturation moves each pixel away from (or towards) its own grey.
  const s = 1 + saturation / 100;
  for (let p = 0; p < out.length; p += 4) {
    const r = curve[out[p]];
    const g = curve[out[p + 1]];
    const b = curve[out[p + 2]];
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    out[p] = grey + (r - grey) * s;
    out[p + 1] = grey + (g - grey) * s;
    out[p + 2] = grey + (b - grey) * s;
  }
  return out;
}

// ---------------------------------------------------------------- colors

/** Closest thread to a Lab colour, among `candidates` (palette indices) or the whole palette. */
function nearestThread(palette: Palette, L: number, a: number, b: number, candidates?: number[]): number {
  const { lab } = palette;
  let best = candidates ? candidates[0] : 1;
  let distance = Infinity;
  const count = candidates ? candidates.length : palette.size;
  for (let k = 0; k < count; k++) {
    const i = candidates ? candidates[k] : k + 1;
    const d = ciede2000(L, a, b, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

/**
 * Choose up to `n` representative colours for the image. Median cut over the colour histogram
 * gives the starting groups; a few rounds of k-means in Lab then move each one to the middle of
 * the pixels it stands for. Returns the Lab of each colour and how many pixels it stands for.
 */
function reduceColors(rgba: Uint8ClampedArray, n: number): { lab: Float64Array; groups: number; pixels: Float64Array } {
  const count = new Uint32Array(BUCKETS);
  const sumR = new Uint32Array(BUCKETS);
  const sumG = new Uint32Array(BUCKETS);
  const sumB = new Uint32Array(BUCKETS);
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] < OPAQUE) continue;
    const k = bucketOf(rgba[p], rgba[p + 1], rgba[p + 2]);
    count[k]++;
    sumR[k] += rgba[p];
    sumG[k] += rgba[p + 1];
    sumB[k] += rgba[p + 2];
  }
  let used = 0;
  for (let k = 0; k < BUCKETS; k++) if (count[k] > 0) used++;
  const ids = new Uint16Array(used);
  for (let k = 0, j = 0; k < BUCKETS; k++) if (count[k] > 0) ids[j++] = k;

  // Median cut: keep splitting the box with the most pixels x colour spread, along its widest channel.
  const SHIFT = [10, 5, 0];
  interface Box {
    from: number;
    to: number;
    axis: number;
    score: number;
  }
  const box = (from: number, to: number): Box => {
    let pixels = 0;
    let axis = 0;
    let spread = 0;
    for (let c = 0; c < 3; c++) {
      let min = 31;
      let max = 0;
      for (let j = from; j < to; j++) {
        const v = (ids[j] >> SHIFT[c]) & 31;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min > spread) {
        spread = max - min;
        axis = c;
      }
    }
    for (let j = from; j < to; j++) pixels += count[ids[j]];
    return { from, to, axis, score: to - from > 1 ? pixels * spread : 0 };
  };
  const boxes: Box[] = used > 0 ? [box(0, used)] : [];
  while (boxes.length < n) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > 0 && (pick < 0 || boxes[i].score > boxes[pick].score)) pick = i;
    if (pick < 0) break;
    const { from, to, axis } = boxes[pick];
    const shift = SHIFT[axis];
    const slice = ids.subarray(from, to);
    slice.sort((x, y) => ((x >> shift) & 31) - ((y >> shift) & 31));
    let pixels = 0;
    for (const id of slice) pixels += count[id];
    let seen = 0;
    let cut = 0;
    while (cut < slice.length - 1 && seen + count[slice[cut]] <= pixels / 2) seen += count[slice[cut++]];
    if (cut === 0) cut = 1;
    boxes[pick] = box(from, from + cut);
    boxes.push(box(from + cut, to));
  }

  const groups = boxes.length;
  const lab = new Float64Array(groups * 3);
  const groupOf = new Int16Array(BUCKETS).fill(-1);
  boxes.forEach((b, g) => {
    let r = 0;
    let gr = 0;
    let bl = 0;
    let pixels = 0;
    for (let j = b.from; j < b.to; j++) {
      const id = ids[j];
      groupOf[id] = g;
      r += sumR[id];
      gr += sumG[id];
      bl += sumB[id];
      pixels += count[id];
    }
    srgbToLab(Math.round(r / pixels), Math.round(gr / pixels), Math.round(bl / pixels), lab, g * 3);
  });

  // k-means over the buckets (weighted by their pixels), in Lab.
  const points = new Float64Array(used * 3);
  for (let j = 0; j < used; j++) {
    const id = ids[j];
    srgbToLab(Math.round(sumR[id] / count[id]), Math.round(sumG[id] / count[id]), Math.round(sumB[id] / count[id]), points, j * 3);
  }
  const sums = new Float64Array(groups * 4);
  for (let round = 0; round < KMEANS_ROUNDS; round++) {
    sums.fill(0);
    for (let j = 0; j < used; j++) {
      let best = 0;
      let distance = Infinity;
      for (let g = 0, o = 0; g < groups; g++, o += 3) {
        const dl = lab[o] - points[j * 3];
        const da = lab[o + 1] - points[j * 3 + 1];
        const db = lab[o + 2] - points[j * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < distance) {
          distance = d;
          best = g;
        }
      }
      const weight = count[ids[j]];
      groupOf[ids[j]] = best;
      sums[best * 4] += points[j * 3] * weight;
      sums[best * 4 + 1] += points[j * 3 + 1] * weight;
      sums[best * 4 + 2] += points[j * 3 + 2] * weight;
      sums[best * 4 + 3] += weight;
    }
    for (let g = 0; g < groups; g++) {
      const weight = sums[g * 4 + 3];
      if (weight === 0) continue;
      lab[g * 3] = sums[g * 4] / weight;
      lab[g * 3 + 1] = sums[g * 4 + 1] / weight;
      lab[g * 3 + 2] = sums[g * 4 + 2] / weight;
    }
  }
  const pixels = new Float64Array(groups);
  for (let j = 0; j < used; j++) pixels[groupOf[ids[j]]] += count[ids[j]];
  return { lab, groups, pixels };
}

/**
 * Stage "colors", first half: which threads the chart will use, at most `maxColors` of them.
 *
 * Several colours of the image often land on the same thread, which would leave the chart with
 * far fewer colours than asked for. So the image is reduced to more colours than needed, growing
 * until enough different threads come out (or the image has no more to give); if that overshoots,
 * the threads covering the most stitches are the ones kept.
 */
export function chooseThreads(rgba: Uint8ClampedArray, palette: Palette, maxColors: number): number[] {
  const limit = Math.max(MIN_COLORS, Math.min(MAX_COLORS, Math.round(maxColors)));
  const stitches = new Map<number, number>();
  for (let groups = limit; ; groups = Math.ceil(groups * 1.6)) {
    const reduced = reduceColors(rgba, groups);
    stitches.clear();
    for (let g = 0; g < reduced.groups; g++) {
      const thread = nearestThread(palette, reduced.lab[g * 3], reduced.lab[g * 3 + 1], reduced.lab[g * 3 + 2]);
      stitches.set(thread, (stitches.get(thread) ?? 0) + reduced.pixels[g]);
    }
    if (stitches.size >= limit || reduced.groups < groups || groups >= limit * MAX_OVERSAMPLE) break;
  }
  return [...stitches.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([index]) => index);
}

/**
 * Stage "colors", second half: one of the chosen `threads` for every pixel. Transparent pixels
 * become empty cells. Without dithering each pixel takes its closest thread; with Floyd-Steinberg
 * the difference between the pixel and its thread is spread over the pixels not yet visited, which
 * trades flat bands for a mix of stitches that reads as the in-between colour.
 */
export function mapToThreads(rgba: Uint8ClampedArray, width: number, height: number, palette: Palette, threads: number[], settings: ColorSettings): Uint16Array {
  const cells = new Uint16Array(width * height);
  if (threads.length === 0) return cells;
  // Closest thread per colour bucket, worked out the first time a bucket is seen.
  const cache = new Uint16Array(BUCKETS);
  const closest = (r: number, g: number, b: number): number => {
    const key = bucketOf(r, g, b);
    if (cache[key] === 0) {
      srgbToLab((r & 0xf8) | 4, (g & 0xf8) | 4, (b & 0xf8) | 4, scratch);
      cache[key] = nearestThread(palette, scratch[0], scratch[1], scratch[2], threads);
    }
    return cache[key];
  };

  if (settings.dither === 'none') {
    for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
      if (rgba[p + 3] >= OPAQUE) cells[i] = closest(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    return cells;
  }

  // Floyd-Steinberg, left to right, top to bottom; two rolling rows of error per channel.
  const amount = Math.max(0, Math.min(100, settings.ditherAmount)) / 100;
  let current = new Float32Array((width + 2) * 3);
  let below = new Float32Array((width + 2) * 3);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const p = i * 4;
      const e = (x + 1) * 3;
      if (rgba[p + 3] < OPAQUE) continue;
      const r = clampByte(Math.round(rgba[p] + current[e]));
      const g = clampByte(Math.round(rgba[p + 1] + current[e + 1]));
      const b = clampByte(Math.round(rgba[p + 2] + current[e + 2]));
      const thread = closest(r, g, b);
      cells[i] = thread;
      for (let c = 0; c < 3; c++) {
        const error = ((c === 0 ? r : c === 1 ? g : b) - palette.rgb[thread * 3 + c]) * amount;
        current[e + 3 + c] += (error * 7) / 16;
        below[e - 3 + c] += (error * 3) / 16;
        below[e + c] += (error * 5) / 16;
        below[e + 3 + c] += error / 16;
      }
    }
    const swap = current;
    current = below;
    below = swap;
    below.fill(0);
  }
  return cells;
}

// ---------------------------------------------------------------- cleanup

/** Replace every colour that has fewer than `minStitches` stitches by the closest colour that stays. Returns whether anything changed. */
function mergeRareColors(cells: Uint16Array, palette: Palette, minStitches: number): boolean {
  const counts = new Map<number, number>();
  for (const v of cells) if (v !== 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  const kept = [...counts.keys()].filter((v) => counts.get(v)! >= minStitches);
  if (kept.length === 0 || kept.length === counts.size) return false;
  const replace = new Map<number, number>();
  for (const v of counts.keys()) {
    if (counts.get(v)! < minStitches) replace.set(v, nearestThread(palette, palette.lab[v * 3], palette.lab[v * 3 + 1], palette.lab[v * 3 + 2], kept));
  }
  for (let i = 0; i < cells.length; i++) {
    const to = replace.get(cells[i]);
    if (to !== undefined) cells[i] = to;
  }
  return true;
}

/**
 * Recolour every group of up to `maxSize` connected stitches of one colour, so that it becomes part
 * of a larger area next to it. Groups that only touch empty fabric are left alone. Returns whether
 * anything changed.
 *
 * The larger areas grow into the small groups, a ring at a time: a group takes the colour of the
 * area that touches it the most and, between areas that touch it equally, of the one closest to its
 * own colour. Every round is decided from the chart as it was when the round began, so the result
 * does not depend on the order the cells are visited in (deciding cell by cell drags colours
 * sideways, in streaks).
 */
function removeConfetti(cells: Uint16Array, width: number, palette: Palette, maxSize: number): boolean {
  /** Cells that belong to an area large enough to stay. */
  const solid = new Uint8Array(cells.length);
  const seen = new Uint8Array(cells.length);
  /** The cells of the small groups, one group after the other, and where each group begins. */
  const members: number[] = [];
  const starts: number[] = [];
  const group: number[] = [];
  const neighbours = (i: number, visit: (j: number) => void) => {
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < cells.length - width) visit(i + width);
  };
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] === 0) continue;
    const color = cells[start];
    group.length = 0;
    group.push(start);
    seen[start] = 1;
    for (let next = 0; next < group.length; next++) {
      neighbours(group[next], (j) => {
        if (!seen[j] && cells[j] === color) {
          seen[j] = 1;
          group.push(j);
        }
      });
    }
    if (group.length > maxSize) {
      for (const i of group) solid[i] = 1;
    } else {
      starts.push(members.length);
      for (const i of group) members.push(i);
    }
  }
  starts.push(members.length);

  const { lab } = palette;
  const distance = (a: number, b: number) => (lab[a * 3] - lab[b * 3]) ** 2 + (lab[a * 3 + 1] - lab[b * 3 + 1]) ** 2 + (lab[a * 3 + 2] - lab[b * 3 + 2]) ** 2;
  const around = new Map<number, number>();
  /** The colour a group should take, looking only at solid neighbours or at all of them. 0 = none. */
  const choose = (g: number, onlySolid: boolean): number => {
    const color = cells[members[starts[g]]];
    around.clear();
    for (let m = starts[g]; m < starts[g + 1]; m++) {
      neighbours(members[m], (j) => {
        const other = cells[j];
        if (other !== 0 && other !== color && (!onlySolid || solid[j])) around.set(other, (around.get(other) ?? 0) + 1);
      });
    }
    let best = 0;
    let touching = 0;
    let far = Infinity;
    for (const [other, n] of around) {
      // Between loose stitches how much they touch says little: there the closest colour wins.
      const d = distance(color, other);
      if (onlySolid ? n > touching || (n === touching && d < far) : d < far) {
        best = other;
        touching = n;
        far = d;
      }
    }
    return best;
  };
  const recolour = (g: number, color: number) => {
    for (let m = starts[g]; m < starts[g + 1]; m++) {
      cells[members[m]] = color;
      solid[members[m]] = 1;
    }
  };

  let changed = false;
  let pending: number[] = [];
  for (let g = 0; g < starts.length - 1; g++) pending.push(g);
  while (pending.length > 0) {
    const decided: [number, number][] = [];
    const rest: number[] = [];
    for (const g of pending) {
      const color = choose(g, true);
      if (color !== 0) decided.push([g, color]);
      else rest.push(g);
    }
    if (decided.length === 0) break;
    for (const [g, color] of decided) recolour(g, color);
    changed = true;
    pending = rest;
  }
  // What is left touches no large area at all: a patch that is confetti through and through.
  // There the groups join each other, each with its closest neighbour; one that has just been
  // joined stays as it is, so that pairs form instead of colours chasing one another.
  for (const g of pending) {
    if (solid[members[starts[g]]]) continue;
    const color = choose(g, false);
    if (color === 0) continue;
    for (let m = starts[g]; m < starts[g + 1]; m++) {
      neighbours(members[m], (j) => {
        if (cells[j] === color) solid[j] = 1;
      });
    }
    recolour(g, color);
    changed = true;
  }
  return changed;
}

/** Stage "cleanup": a copy of the chart with rare colours merged and confetti removed. */
export function cleanUp(cells: Uint16Array, width: number, height: number, palette: Palette, settings: CleanupSettings): Uint16Array {
  const out = new Uint16Array(cells);
  // The two feed each other: absorbing a group can leave another one small, or a colour with too
  // few stitches, and merging a colour can join or strand stitches. So they alternate until
  // nothing moves (which takes a few rounds; the limit is only a safeguard).
  for (let round = 0; round < CLEANUP_ROUNDS; round++) {
    let changed = false;
    if (settings.confetti > 0) changed = removeConfetti(out, width, palette, settings.confetti) || changed;
    if (settings.minStitches > 0) changed = mergeRareColors(out, palette, settings.minStitches) || changed;
    if (!changed) break;
  }
  return out;
}

// ---------------------------------------------------------------- whole pipeline

export function chartStats(cells: Uint16Array, width: number): ChartStats {
  const colors = new Set<number>();
  let stitches = 0;
  let isolated = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v === 0) continue;
    stitches++;
    colors.add(v);
    const x = i % width;
    const alone = (x === 0 || cells[i - 1] !== v) && (x === width - 1 || cells[i + 1] !== v) && cells[i - width] !== v && cells[i + width] !== v;
    if (alone) isolated++;
  }
  return { stitches, colors: colors.size, isolated };
}

/**
 * Run the stages after "size" on pixels that are already one per stitch, stopping after `upTo`.
 * Returns pixels for the stages that still produce an image, a chart for the ones that produce stitches.
 */
export function runPipeline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Palette,
  settings: PipelineSettings,
  upTo: Stage = 'cleanup',
): { pixels: Uint8ClampedArray } | { cells: Uint16Array; stats: ChartStats } {
  if (upTo === 'size') return { pixels: rgba };
  const adjusted = adjustPixels(rgba, settings.adjust);
  if (upTo === 'adjust') return { pixels: adjusted };
  const threads = chooseThreads(adjusted, palette, settings.colors.maxColors);
  let cells = mapToThreads(adjusted, width, height, palette, threads, settings.colors);
  if (upTo === 'cleanup') cells = cleanUp(cells, width, height, palette, settings.cleanup);
  return { cells, stats: chartStats(cells, width) };
}
