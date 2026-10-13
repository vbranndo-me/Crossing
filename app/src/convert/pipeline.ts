import { ciede2000, labToSrgb, srgbToLab } from '../core/color.ts';
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
 *   simplify redraw with a few flat colours, still RGB       simplifyColors
 *   colors   pick the threads, then give every stitch one    chooseThreads + mapToThreads
 *   cleanup  merge rare colours, remove confetti             cleanUp
 *
 * Everything here is plain computation on arrays, so it runs the same in a worker or in tests.
 */
export const STAGES = ['size', 'adjust', 'simplify', 'colors', 'cleanup'] as const;
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

export const SIMPLIFY_METHODS = ['kmeans', 'median'] as const;
export type SimplifyMethod = (typeof SIMPLIFY_METHODS)[number];

export interface SimplifySettings {
  /** Off: the image goes on to the threads as it is. */
  enabled: boolean;
  /** How many colours the image is redrawn with. */
  colors: number;
  /** How they are picked: median cut alone, or refined by k-means (closer to the large areas). */
  method: SimplifyMethod;
  /** Colours closer to each other than this (distance in Lab) become one. 0 = off. */
  tolerance: number;
  /** Edge-preserving smoothing before the colours are picked, 0 (off) to 10. */
  smooth: number;
  /** Patches of up to this many pixels are absorbed by their surroundings. 0 = off. */
  minRegion: number;
  /** Edits made by hand, as 0xRRGGBB values: colours that must be in the list, */
  pinned: number[];
  /** colours taken out of it (their pixels go to the closest one left), */
  removed: number[];
  /** and colours merged into another: [from, into]. */
  merged: [number, number][];
}

/** One colour of the simplified image. */
export interface SimplifiedColor {
  /** 0xRRGGBB. */
  rgb: number;
  pixels: number;
  pinned: boolean;
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
  simplify: SimplifySettings;
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
export const MAX_SIMPLE_COLORS = 64;
export const MAX_TOLERANCE = 30;
export const MAX_SMOOTH = 10;
export const MAX_REGION = 20;
export const MAX_CONFETTI = 8;
export const MAX_MIN_STITCHES = 200;

export const DEFAULT_SETTINGS: PipelineSettings = {
  size: { method: 'lanczos', thickness: 2 },
  adjust: { brightness: 0, contrast: 0, saturation: 0 },
  simplify: { enabled: true, colors: 32, method: 'kmeans', tolerance: 0, smooth: 0, minRegion: 0, pinned: [], removed: [], merged: [] },
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
 * gives the starting groups; with `refine`, a few rounds of k-means in Lab then move each one to
 * the middle of the pixels it stands for. Returns the Lab of each colour and how many pixels it stands for.
 */
function reduceColors(rgba: Uint8ClampedArray, n: number, refine = true): { lab: Float64Array; groups: number; pixels: Float64Array } {
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
  for (let round = 0; round < (refine ? KMEANS_ROUNDS : 0); round++) {
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
function removeConfetti(cells: Uint16Array, width: number, lab: Float64Array, maxSize: number): boolean {
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
    if (settings.confetti > 0) changed = removeConfetti(out, width, palette.lab, settings.confetti) || changed;
    if (settings.minStitches > 0) changed = mergeRareColors(out, palette, settings.minStitches) || changed;
    if (!changed) break;
  }
  return out;
}

// ---------------------------------------------------------------- simplify

/** Edge-preserving smoothing (a bilateral filter): flattens texture and noise, keeps the borders between areas. */
function smoothPixels(rgba: Uint8ClampedArray, width: number, height: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const R = 2;
  // How different a neighbour's colour may be and still count: the stronger, the more is blended.
  const range = -1 / (2 * (8 * strength) ** 2);
  const near: number[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) near.push(Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (rgba[p + 3] < OPAQUE) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let dy = -R, k = 0; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++, k++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = (ny * width + nx) * 4;
          if (rgba[q + 3] < OPAQUE) continue;
          const dr = rgba[q] - rgba[p];
          const dg = rgba[q + 1] - rgba[p + 1];
          const db = rgba[q + 2] - rgba[p + 2];
          const w = near[k] * Math.exp((dr * dr + dg * dg + db * db) * range);
          r += rgba[q] * w;
          g += rgba[q + 1] * w;
          b += rgba[q + 2] * w;
          total += w;
        }
      }
      out[p] = r / total;
      out[p + 1] = g / total;
      out[p + 2] = b / total;
    }
  }
  return out;
}

/**
 * Stage "simplify": the image redrawn with a short list of flat colours, still free RGB (no
 * thread is involved yet). In order:
 *
 *   1. smooth the image, keeping edges (optional);
 *   2. pick the colours (median cut, optionally refined by k-means), plus the ones pinned by hand;
 *   3. merge colours closer to each other than the tolerance: the one with more pixels stays;
 *   4. apply the edits made by hand: colours removed, colours merged into another;
 *   5. give every pixel its closest colour;
 *   6. absorb patches of up to `minRegion` pixels into what surrounds them.
 *
 * Returns the pixels and the colours they use, most used first.
 */
export function simplifyColors(rgba: Uint8ClampedArray, width: number, height: number, s: SimplifySettings): { pixels: Uint8ClampedArray; palette: SimplifiedColor[] } {
  if (!s.enabled) return { pixels: rgba, palette: [] };
  const source = s.smooth > 0 ? smoothPixels(rgba, width, height, s.smooth) : rgba;
  const pins = [...new Set(s.pinned)].filter((rgb) => !s.removed.includes(rgb));
  const wanted = Math.max(MIN_COLORS, Math.min(MAX_SIMPLE_COLORS, Math.round(s.colors)));
  const reduced = reduceColors(source, Math.max(1, wanted - pins.length), s.method === 'kmeans');

  interface Entry {
    rgb: number;
    lab: number[];
    weight: number;
    pinned: boolean;
    removed: boolean;
    /** Merged into this other entry; -1 = stands for itself. */
    to: number;
  }
  const entries: Entry[] = [];
  const add = (rgb: number, weight: number, pinned: boolean) => {
    const same = entries.find((e) => e.rgb === rgb);
    if (same) {
      same.weight += weight;
      same.pinned ||= pinned;
      return;
    }
    const lab = [0, 0, 0];
    srgbToLab(rgb >> 16, (rgb >> 8) & 255, rgb & 255, lab);
    entries.push({ rgb, lab, weight, pinned, removed: false, to: -1 });
  };
  const byte = [0, 0, 0];
  for (let g = 0; g < reduced.groups; g++) {
    labToSrgb(reduced.lab[g * 3], reduced.lab[g * 3 + 1], reduced.lab[g * 3 + 2], byte);
    add((clampByte(Math.round(byte[0])) << 16) | (clampByte(Math.round(byte[1])) << 8) | clampByte(Math.round(byte[2])), reduced.pixels[g], false);
  }
  for (const rgb of pins) add(rgb, 0, true);

  const apart = (a: Entry, b: Entry) => Math.hypot(a.lab[0] - b.lab[0], a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]);
  // Merge the closest pair, again and again, until no two colours are closer than the tolerance.
  while (s.tolerance > 0) {
    let from = -1;
    let into = -1;
    let closest = s.tolerance;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].to >= 0) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].to >= 0 || (entries[i].pinned && entries[j].pinned)) continue;
        const d = apart(entries[i], entries[j]);
        if (d >= closest) continue;
        closest = d;
        // A pinned colour always stays; otherwise the one that stands for more pixels.
        const keepI = entries[i].pinned || (!entries[j].pinned && entries[i].weight >= entries[j].weight);
        from = keepI ? j : i;
        into = keepI ? i : j;
      }
    }
    if (from < 0) break;
    entries[from].to = into;
    entries[into].weight += entries[from].weight;
  }
  // Edits made by hand name colours by their value; one that no longer exists is simply skipped.
  const standing = (rgb: number) => entries.findIndex((e) => e.rgb === rgb && e.to < 0 && !e.removed);
  for (const [fromRgb, intoRgb] of s.merged) {
    const from = standing(fromRgb);
    const into = standing(intoRgb);
    if (from >= 0 && into >= 0 && from !== into) entries[from].to = into;
  }
  for (const rgb of s.removed) {
    const at = standing(rgb);
    if (at >= 0) entries[at].removed = true;
  }
  const final = (i: number) => {
    while (entries[i].to >= 0) i = entries[i].to;
    return i;
  };
  // A pixel may land on a merged colour (and is passed on), never on a removed one.
  const candidates: number[] = [];
  for (let i = 0; i < entries.length; i++) if (!entries[final(i)].removed) candidates.push(i);
  if (candidates.length === 0) return { pixels: source, palette: [] };

  const cache = new Int16Array(BUCKETS).fill(-1);
  const cells = new Uint16Array(width * height);
  for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
    if (source[p + 3] < OPAQUE) continue;
    const key = bucketOf(source[p], source[p + 1], source[p + 2]);
    if (cache[key] < 0) {
      srgbToLab((source[p] & 0xf8) | 4, (source[p + 1] & 0xf8) | 4, (source[p + 2] & 0xf8) | 4, scratch);
      let best = candidates[0];
      let distance = Infinity;
      for (const c of candidates) {
        const { lab } = entries[c];
        const d = (lab[0] - scratch[0]) ** 2 + (lab[1] - scratch[1]) ** 2 + (lab[2] - scratch[2]) ** 2;
        if (d < distance) {
          distance = d;
          best = c;
        }
      }
      cache[key] = final(best);
    }
    cells[i] = cache[key] + 1;
  }
  if (s.minRegion > 0) {
    const lab = new Float64Array((entries.length + 1) * 3);
    entries.forEach((e, i) => lab.set(e.lab, (i + 1) * 3));
    removeConfetti(cells, width, lab, s.minRegion);
  }

  const pixels = new Uint8ClampedArray(rgba.length);
  const used = new Uint32Array(entries.length);
  for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
    if (cells[i] === 0) continue;
    const { rgb } = entries[cells[i] - 1];
    used[cells[i] - 1]++;
    pixels[p] = rgb >> 16;
    pixels[p + 1] = (rgb >> 8) & 255;
    pixels[p + 2] = rgb & 255;
    pixels[p + 3] = 255;
  }
  const palette: SimplifiedColor[] = [];
  entries.forEach((e, i) => {
    if (e.to < 0 && !e.removed && (used[i] > 0 || e.pinned)) palette.push({ rgb: e.rgb, pixels: used[i], pinned: e.pinned });
  });
  palette.sort((a, b) => b.pixels - a.pixels);
  return { pixels, palette };
}

/** A colour difference (in Lab) below this is not seen by most people, even side by side. */
export const VISIBLE_DELTA = 2.3;
/** The analysis looks at about this many pixels at most: a sample gives practically the same curve. */
const ANALYSIS_PIXELS = 120_000;
/** Numbers of colours that are tried: every one at first, where the curve is steep, then further apart. */
const ANALYSIS_COUNTS: number[] = [];
for (let n = MIN_COLORS; n <= MAX_SIMPLE_COLORS; n += n < 16 ? 1 : n < 32 ? 2 : 4) ANALYSIS_COUNTS.push(n);

/** How far the simplified image is from the one it was made from, for a range of numbers of colours. */
export interface ColorAnalysis {
  /** The numbers of colours tried, rising. */
  counts: number[];
  /** For each: the mean colour difference per pixel (Lab distance), */
  error: number[];
  /** and the share of pixels, 0 to 1, whose difference is large enough to be seen. */
  visible: number[];
  /** The number of colours from which adding more changes almost nothing. */
  suggested: number;
}

/**
 * Simplify the image with more and more colours and measure, each time, how different the result
 * is from the image. The difference falls fast at first and then flattens; the suggestion is where
 * it is either already invisible on average, or within 15% of the best that can be had.
 * Tolerance, patch size and the edits made by hand are left out: this is about the count alone.
 */
export function analyzeColors(rgba: Uint8ClampedArray, width: number, height: number, s: SimplifySettings): ColorAnalysis {
  const source = s.smooth > 0 ? smoothPixels(rgba, width, height, s.smooth) : rgba;
  // Every `step`-th pixel each way, when the image is large.
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / ANALYSIS_PIXELS)));
  let sample = source;
  if (step > 1) {
    const w = Math.ceil(width / step);
    const h = Math.ceil(height / step);
    sample = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, o = 0; y < h; y++) {
      for (let x = 0; x < w; x++, o += 4) {
        const p = (y * step * width + x * step) * 4;
        sample[o] = source[p];
        sample[o + 1] = source[p + 1];
        sample[o + 2] = source[p + 2];
        sample[o + 3] = source[p + 3];
      }
    }
  }
  // The image as a histogram: one point per colour bucket, weighted by its pixels.
  const count = new Uint32Array(BUCKETS);
  const sums = new Float64Array(BUCKETS * 3);
  let total = 0;
  for (let p = 0; p < sample.length; p += 4) {
    if (sample[p + 3] < OPAQUE) continue;
    const k = bucketOf(sample[p], sample[p + 1], sample[p + 2]);
    count[k]++;
    sums[k * 3] += sample[p];
    sums[k * 3 + 1] += sample[p + 1];
    sums[k * 3 + 2] += sample[p + 2];
    total++;
  }
  const points: number[] = [];
  const weights: number[] = [];
  for (let k = 0; k < BUCKETS; k++) {
    if (count[k] === 0) continue;
    srgbToLab(Math.round(sums[k * 3] / count[k]), Math.round(sums[k * 3 + 1] / count[k]), Math.round(sums[k * 3 + 2] / count[k]), scratch);
    points.push(scratch[0], scratch[1], scratch[2]);
    weights.push(count[k]);
  }

  const error: number[] = [];
  const visible: number[] = [];
  for (const n of ANALYSIS_COUNTS) {
    const { lab, groups } = reduceColors(sample, n, s.method === 'kmeans');
    let sum = 0;
    let seen = 0;
    for (let j = 0; j < weights.length; j++) {
      let closest = Infinity;
      for (let g = 0, o = 0; g < groups; g++, o += 3) {
        const d = (lab[o] - points[j * 3]) ** 2 + (lab[o + 1] - points[j * 3 + 1]) ** 2 + (lab[o + 2] - points[j * 3 + 2]) ** 2;
        if (d < closest) closest = d;
      }
      const d = Math.sqrt(closest);
      sum += d * weights[j];
      if (d > VISIBLE_DELTA) seen += weights[j];
    }
    error.push(total ? sum / total : 0);
    visible.push(total ? seen / total : 0);
  }
  const best = error[error.length - 1];
  const close = best + 0.15 * (error[0] - best);
  let at = error.findIndex((e) => e <= VISIBLE_DELTA || e <= close);
  if (at < 0) at = error.length - 1;
  return { counts: [...ANALYSIS_COUNTS], error, visible, suggested: ANALYSIS_COUNTS[at] };
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
): { pixels: Uint8ClampedArray; palette?: SimplifiedColor[] } | { cells: Uint16Array; stats: ChartStats } {
  if (upTo === 'size') return { pixels: rgba };
  const adjusted = adjustPixels(rgba, settings.adjust);
  if (upTo === 'adjust') return { pixels: adjusted };
  const simplified = simplifyColors(adjusted, width, height, settings.simplify);
  if (upTo === 'simplify') return simplified;
  const threads = chooseThreads(simplified.pixels, palette, settings.colors.maxColors);
  let cells = mapToThreads(simplified.pixels, width, height, palette, threads, settings.colors);
  if (upTo === 'cleanup') cells = cleanUp(cells, width, height, palette, settings.cleanup);
  return { cells, stats: chartStats(cells, width) };
}
