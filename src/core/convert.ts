import { ciede2000, srgbToLab } from './color.ts';
import type { Palette } from './palette.ts';

/**
 * v1: CIEDE2000 against every palette entry, per pixel.
 * v2: same, behind a cache keyed by the input colour quantized to 15 bits.
 * v3: reduce the image to `n` colours first, then match only those `n`.
 */
export type Variant = 'v1' | 'v2' | 'v3';

export interface ConvertOptions {
  variant: Variant;
  /** v3: number of colours to reduce to. */
  n?: number;
  /** v3: colour reduction algorithm. */
  quantizer?: 'median' | 'kmeans';
  /** Floyd-Steinberg error diffusion. */
  dither?: boolean;
  /**
   * v1 only: if pixels x palette size exceeds this, only every k-th row is converted
   * (see `rowStride` in the result) so the naive baseline stays measurable.
   */
  maxNaiveOps?: number;
}

export interface StageTimes {
  lab: number;
  quantize: number;
  map: number;
  dither: number;
}

export interface ConvertResult {
  cells: Uint16Array;
  stages: StageTimes;
  /** 1 = every row converted. k > 1 = only rows y % k == 0 (others are left empty). */
  rowStride: number;
}

const BUCKETS = 32768;
const now = () => performance.now();

const bucketOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

export function nearestEntry(pal: Palette, L: number, a: number, b: number): number {
  const lab = pal.lab;
  let best = 1;
  let bestD = Infinity;
  for (let i = 1, o = 3; i <= pal.size; i++, o += 3) {
    const d = ciede2000(L, a, b, lab[o], lab[o + 1], lab[o + 2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

interface Reduced {
  k: number;
  /** Lab of each reduced colour. */
  lab: Float64Array;
  /** Bucket -> reduced colour, -1 for buckets absent from the image. */
  boxOf: Int16Array;
}

/** Median cut over the 15-bit colour histogram, optionally refined with k-means in Lab. */
function reduceColors(rgba: Uint8ClampedArray, n: number, kmeans: boolean): Reduced {
  const count = new Uint32Array(BUCKETS);
  const sr = new Uint32Array(BUCKETS);
  const sg = new Uint32Array(BUCKETS);
  const sb = new Uint32Array(BUCKETS);
  for (let p = 0; p < rgba.length; p += 4) {
    const k = bucketOf(rgba[p], rgba[p + 1], rgba[p + 2]);
    count[k]++;
    sr[k] += rgba[p];
    sg[k] += rgba[p + 1];
    sb[k] += rgba[p + 2];
  }
  let used = 0;
  for (let k = 0; k < BUCKETS; k++) if (count[k]) used++;
  const ids = new Uint16Array(used);
  for (let k = 0, j = 0; k < BUCKETS; k++) if (count[k]) ids[j++] = k;

  const SHIFT = [10, 5, 0];
  interface Box {
    lo: number;
    hi: number;
    axis: number;
    score: number;
  }
  const makeBox = (lo: number, hi: number): Box => {
    let pop = 0;
    let axis = 0;
    let range = 0;
    for (let c = 0; c < 3; c++) {
      let min = 31;
      let max = 0;
      for (let j = lo; j < hi; j++) {
        const v = (ids[j] >> SHIFT[c]) & 31;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min > range) {
        range = max - min;
        axis = c;
      }
    }
    for (let j = lo; j < hi; j++) pop += count[ids[j]];
    return { lo, hi, axis, score: hi - lo > 1 ? pop * range : 0 };
  };

  const boxes: Box[] = used ? [makeBox(0, used)] : [];
  while (boxes.length < n) {
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > 0 && (bi < 0 || boxes[i].score > boxes[bi].score)) bi = i;
    if (bi < 0) break;
    const box = boxes[bi];
    const shift = SHIFT[box.axis];
    const slice = ids.subarray(box.lo, box.hi);
    slice.sort((x, y) => ((x >> shift) & 31) - ((y >> shift) & 31));
    let pop = 0;
    for (let j = 0; j < slice.length; j++) pop += count[slice[j]];
    let acc = 0;
    let cut = 0;
    while (cut < slice.length - 1 && acc + count[slice[cut]] <= pop / 2) acc += count[slice[cut++]];
    if (cut === 0) cut = 1;
    boxes[bi] = makeBox(box.lo, box.lo + cut);
    boxes.push(makeBox(box.lo + cut, box.hi));
  }

  const k = boxes.length;
  const lab = new Float64Array(k * 3);
  const boxOf = new Int16Array(BUCKETS).fill(-1);
  for (let i = 0; i < k; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let pop = 0;
    for (let j = boxes[i].lo; j < boxes[i].hi; j++) {
      const id = ids[j];
      boxOf[id] = i;
      r += sr[id];
      g += sg[id];
      b += sb[id];
      pop += count[id];
    }
    srgbToLab(Math.round(r / pop), Math.round(g / pop), Math.round(b / pop), lab, i * 3);
  }
  if (!kmeans) return { k, lab, boxOf };

  // Lloyd iterations over the histogram buckets (weighted by pixel count), Euclidean in Lab.
  const pts = new Float64Array(used * 3);
  for (let j = 0; j < used; j++) {
    const id = ids[j];
    srgbToLab(Math.round(sr[id] / count[id]), Math.round(sg[id] / count[id]), Math.round(sb[id] / count[id]), pts, j * 3);
  }
  const sum = new Float64Array(k * 4);
  for (let iter = 0; iter < 8; iter++) {
    sum.fill(0);
    for (let j = 0; j < used; j++) {
      const c = nearestCentroid(lab, k, pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]);
      const wgt = count[ids[j]];
      boxOf[ids[j]] = c;
      sum[c * 4] += pts[j * 3] * wgt;
      sum[c * 4 + 1] += pts[j * 3 + 1] * wgt;
      sum[c * 4 + 2] += pts[j * 3 + 2] * wgt;
      sum[c * 4 + 3] += wgt;
    }
    for (let c = 0; c < k; c++) {
      const wgt = sum[c * 4 + 3];
      if (wgt === 0) continue;
      lab[c * 3] = sum[c * 4] / wgt;
      lab[c * 3 + 1] = sum[c * 4 + 1] / wgt;
      lab[c * 3 + 2] = sum[c * 4 + 2] / wgt;
    }
  }
  return { k, lab, boxOf };
}

function nearestCentroid(lab: Float64Array, k: number, L: number, a: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0, o = 0; c < k; c++, o += 3) {
    const dl = lab[o] - L;
    const da = lab[o + 1] - a;
    const db = lab[o + 2] - b;
    const d = dl * dl + da * da + db * db;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const tmp = new Float64Array(3);

/** Convert RGBA pixels (already resized to the grid size) into palette indices. */
export function convert(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  pal: Palette,
  opts: ConvertOptions,
): ConvertResult {
  const total = width * height;
  const cells = new Uint16Array(total);
  const stages: StageTimes = { lab: 0, quantize: 0, map: 0, dither: 0 };
  let rowStride = 1;
  let t = now();

  // Each variant ends up as a colour -> palette index lookup.
  let lookup: (r: number, g: number, b: number) => number;
  if (opts.variant === 'v1') {
    lookup = (r, g, b) => {
      srgbToLab(r, g, b, tmp);
      return nearestEntry(pal, tmp[0], tmp[1], tmp[2]);
    };
    const ops = total * pal.size;
    if (opts.maxNaiveOps && ops > opts.maxNaiveOps) rowStride = Math.ceil(ops / opts.maxNaiveOps);
  } else {
    const table = new Int32Array(BUCKETS).fill(-1);
    let reduced: Reduced | null = null;
    let boxEntry: Uint16Array | null = null;
    if (opts.variant === 'v3') {
      reduced = reduceColors(rgba, opts.n ?? 32, opts.quantizer === 'kmeans');
      stages.quantize = now() - t;
      t = now();
      boxEntry = new Uint16Array(reduced.k);
      for (let c = 0; c < reduced.k; c++) {
        boxEntry[c] = nearestEntry(pal, reduced.lab[c * 3], reduced.lab[c * 3 + 1], reduced.lab[c * 3 + 2]);
      }
      for (let k = 0; k < BUCKETS; k++) if (reduced.boxOf[k] >= 0) table[k] = boxEntry[reduced.boxOf[k]];
    }
    lookup = (r, g, b) => {
      const key = bucketOf(r, g, b);
      let v = table[key];
      if (v < 0) {
        // Cache miss: match the centre of the bucket.
        srgbToLab((r & 0xf8) | 4, (g & 0xf8) | 4, (b & 0xf8) | 4, tmp);
        v = reduced
          ? boxEntry![nearestCentroid(reduced.lab, reduced.k, tmp[0], tmp[1], tmp[2])]
          : nearestEntry(pal, tmp[0], tmp[1], tmp[2]);
        table[key] = v;
      }
      return v;
    };
  }

  if (opts.dither) {
    // Floyd-Steinberg in sRGB; two rolling rows of accumulated error.
    let cur = new Float32Array((width + 2) * 3);
    let next = new Float32Array((width + 2) * 3);
    const prgb = pal.rgb;
    const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const e = (x + 1) * 3;
        const r = clamp(rgba[i * 4] + cur[e]);
        const g = clamp(rgba[i * 4 + 1] + cur[e + 1]);
        const b = clamp(rgba[i * 4 + 2] + cur[e + 2]);
        const v = lookup(r, g, b);
        cells[i] = v;
        const er = r - prgb[v * 3];
        const eg = g - prgb[v * 3 + 1];
        const eb = b - prgb[v * 3 + 2];
        cur[e + 3] += (er * 7) / 16;
        cur[e + 4] += (eg * 7) / 16;
        cur[e + 5] += (eb * 7) / 16;
        next[e - 3] += (er * 3) / 16;
        next[e - 2] += (eg * 3) / 16;
        next[e - 1] += (eb * 3) / 16;
        next[e] += (er * 5) / 16;
        next[e + 1] += (eg * 5) / 16;
        next[e + 2] += (eb * 5) / 16;
        next[e + 3] += er / 16;
        next[e + 4] += eg / 16;
        next[e + 5] += eb / 16;
      }
      const swap = cur;
      cur = next;
      next = swap;
      next.fill(0);
    }
    stages.dither = now() - t;
  } else if (opts.variant === 'v1') {
    const lab = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) srgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], lab, i * 3);
    stages.lab = now() - t;
    t = now();
    for (let y = 0; y < height; y += rowStride) {
      for (let i = y * width, end = i + width; i < end; i++) {
        cells[i] = nearestEntry(pal, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
      }
    }
    stages.map = now() - t;
  } else {
    for (let i = 0; i < total; i++) cells[i] = lookup(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    stages.map = now() - t;
  }
  return { cells, stages, rowStride };
}

/** Quality check: mean CIEDE2000 between each source pixel and the palette colour chosen for it. */
export function meanDeltaE(rgba: Uint8ClampedArray, width: number, height: number, cells: Uint16Array, pal: Palette, rowStride = 1): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += rowStride) {
    for (let i = y * width, end = i + width; i < end; i++, n++) {
      srgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], tmp);
      const o = cells[i] * 3;
      sum += ciede2000(tmp[0], tmp[1], tmp[2], pal.lab[o], pal.lab[o + 1], pal.lab[o + 2]);
    }
  }
  return sum / n;
}
