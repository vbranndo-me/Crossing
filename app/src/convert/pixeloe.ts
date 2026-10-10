/**
 * PixelOE: detail-oriented pixelization based on contrast-aware outline expansion.
 *
 * This file is a TypeScript port of the reference ("legacy", NumPy) implementation of PixelOE by
 * Shih-Ying Yeh (KohakuBlueleaf), https://github.com/KohakuBlueleaf/PixelOE, which is licensed
 * under the Apache License 2.0. The steps and constants follow pixeloe/legacy (pixelize.py,
 * outline.py, color.py, downscale/contrast_based.py). Differences from the original are marked
 * "port:" below: the Gaussian blurs are approximated with box blurs, the outline weights are
 * normalized as in the project's newer torch code, and transparency is carried through.
 *
 * The idea: plain downscaling averages thin lines and small details away. PixelOE first thickens
 * them (dark outlines grow where the surroundings are bright, bright details where they are
 * dark), then picks, for each block that becomes one output pixel, the pixel that carries the
 * block's contrast instead of the block's average.
 */
import { labToSrgb, srgbToLab } from '../core/color.ts';
import { resample } from './resample.ts';

export interface PixelOESettings {
  /** How many pixels outlines are expanded by before downscaling. 0 skips the expansion. */
  thickness: number;
}

export const MAX_THICKNESS = 4;

/**
 * Working pixels per output pixel ("patch size"). Even, at least 4, as the algorithm's strides need.
 * It has to stay small next to the thickness: a line only survives the downscale if, once
 * expanded, it fills most of a patch. 6 with thickness 2 is the combination the project's examples use.
 */
const PATCHES = [6, 4];
/** The image is processed at output size x patch; this caps that, so big charts use a smaller patch. */
const MAX_WORKING_PIXELS = 3_000_000;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** The reference takes the lower of the two middle values for an even count (torch.median). */
function lowerMedian(values: Float32Array, count: number): number {
  const sorted = values.subarray(0, count).sort();
  return sorted[(count - 1) >> 1];
}

/**
 * Reduce a `window` x `window` neighbourhood around every `stride` x `stride` block to one value
 * (the reference's apply_chunk: edges are padded by repeating the border). Returns one value per block.
 */
function perBlock(plane: Float32Array, width: number, height: number, window: number, stride: number, reduce: (values: Float32Array, count: number) => number): Float32Array {
  const across = Math.floor(width / stride);
  const down = Math.floor(height / stride);
  const before = Math.max(window - stride, 0) >> 1;
  const out = new Float32Array(across * down);
  const values = new Float32Array(window * window);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      let n = 0;
      for (let dy = 0; dy < window; dy++) {
        const y = Math.min(height - 1, Math.max(0, by * stride - before + dy));
        for (let dx = 0; dx < window; dx++) {
          const x = Math.min(width - 1, Math.max(0, bx * stride - before + dx));
          values[n++] = plane[y * width + x];
        }
      }
      out[by * across + bx] = reduce(values, n);
    }
  }
  return out;
}

/**
 * perBlock with the lower median, for lightness in 0..1, done with a histogram that slides along
 * each row of blocks instead of sorting every window. The values are taken at 8 bits, which is
 * also what the reference works with (OpenCV's 8-bit Lab).
 */
function blockMedian(plane: Float32Array, width: number, height: number, window: number, stride: number): Float32Array {
  const across = Math.floor(width / stride);
  const down = Math.floor(height / stride);
  const before = Math.max(window - stride, 0) >> 1;
  const levels = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) levels[i] = Math.round(plane[i] * 255);
  const out = new Float32Array(across * down);
  const histogram = new Int32Array(256);
  const half = ((window * window - 1) >> 1) + 1; // how many values are at or below the lower median
  const rows = new Int32Array(window);
  const column = (x: number, by: number) => Math.min(width - 1, Math.max(0, x)) + 0 * by;
  for (let by = 0; by < down; by++) {
    for (let dy = 0; dy < window; dy++) rows[dy] = Math.min(height - 1, Math.max(0, by * stride - before + dy)) * width;
    histogram.fill(0);
    // The window of the first block, then one stride of columns out and one in per block.
    for (let dx = 0; dx < window; dx++) {
      const x = column(dx - before, by);
      for (let dy = 0; dy < window; dy++) histogram[levels[rows[dy] + x]]++;
    }
    for (let bx = 0; bx < across; bx++) {
      if (bx > 0) {
        const left = (bx - 1) * stride - before;
        for (let k = 0; k < stride; k++) {
          const gone = column(left + k, by);
          const come = column(left + window + k, by);
          for (let dy = 0; dy < window; dy++) {
            histogram[levels[rows[dy] + gone]]--;
            histogram[levels[rows[dy] + come]]++;
          }
        }
      }
      let level = 0;
      for (let seen = histogram[0]; seen < half; seen += histogram[++level]);
      out[by * across + bx] = level / 255;
    }
  }
  return out;
}

const maxOf = (values: Float32Array, count: number) => {
  let m = -Infinity;
  for (let i = 0; i < count; i++) if (values[i] > m) m = values[i];
  return m;
};
const minOf = (values: Float32Array, count: number) => {
  let m = Infinity;
  for (let i = 0; i < count; i++) if (values[i] < m) m = values[i];
  return m;
};

/** Bilinear enlargement of a small grid to `width` x `height` (pixel centres aligned, edges repeated). */
function enlarge(grid: Float32Array, gridWidth: number, gridHeight: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.max(0, Math.min(gridHeight - 1, ((y + 0.5) * gridHeight) / height - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(gridHeight - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.max(0, Math.min(gridWidth - 1, ((x + 0.5) * gridWidth) / width - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(gridWidth - 1, x0 + 1);
      const fx = gx - x0;
      const top = grid[y0 * gridWidth + x0] * (1 - fx) + grid[y0 * gridWidth + x1] * fx;
      const bottom = grid[y1 * gridWidth + x0] * (1 - fx) + grid[y1 * gridWidth + x1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * Where to expand dark and where to expand bright (expansion_weight): close to 1 where the
 * neighbourhood is bright and what stands out in it is dark, close to 0 for the opposite.
 */
function expansionWeight(lightness: Float32Array, width: number, height: number, patch: number): Float32Array {
  const AVG_SCALE = 9;
  const DIST_SCALE = 4;
  const stride = (patch >> 2) * 2;
  const median = blockMedian(lightness, width, height, patch * 2, stride);
  const max = perBlock(lightness, width, height, patch, stride, maxOf);
  const min = perBlock(lightness, width, height, patch, stride, minOf);
  const grid = new Float32Array(median.length);
  for (let i = 0; i < grid.length; i++) {
    const bright = max[i] - median[i];
    const dark = median[i] - min[i];
    grid[i] = sigmoid((median[i] - 0.5) * AVG_SCALE - (bright - dark) * DIST_SCALE);
  }
  const weight = enlarge(grid, Math.floor(width / stride), Math.floor(height / stride), width, height);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < weight.length; i++) {
    if (weight[i] < lo) lo = weight[i];
    if (weight[i] > hi) hi = weight[i];
  }
  // port: stretched to the full 0..1 range, as the project's newer (torch) implementation does.
  // The legacy code divides by the maximum instead, which on a mostly flat image (line art on
  // white) squeezes every weight to ~0 and erases the very lines this is meant to keep.
  for (let i = 0; i < weight.length; i++) weight[i] = (weight[i] - lo) / (hi - lo + 1e-8);
  return weight;
}

/**
 * Morphological erosion (`dilate` false: each pixel takes the darkest value around it) or dilation,
 * per channel, `times` times. `square` uses the full 3 x 3 neighbourhood, otherwise the plus shape.
 * Pixels outside the image are ignored, as OpenCV does by default.
 */
function morph(rgb: Uint8ClampedArray, width: number, height: number, times: number, dilate: boolean, square: boolean): Uint8ClampedArray {
  if (times === 0) return rgb;
  const row = width * 3;
  const size = rgb.length;
  // Erosion is dilation of the negative: one set of loops serves both.
  let from = new Uint8Array(size);
  if (dilate) from.set(rgb);
  else for (let i = 0; i < size; i++) from[i] = 255 - rgb[i];
  let to = new Uint8Array(size);
  const middle = new Uint8Array(size);
  for (let pass = 0; pass < times; pass++) {
    if (square) {
      // A 3 x 3 maximum is a maximum along the row followed by one along the column.
      for (let y = 0, i = 0; y < height; y++) {
        const end = i + row;
        for (let start = i; i < end; i++) {
          let m = from[i];
          if (i - 3 >= start && from[i - 3] > m) m = from[i - 3];
          if (i + 3 < end && from[i + 3] > m) m = from[i + 3];
          middle[i] = m;
        }
      }
      for (let i = 0; i < size; i++) {
        let m = middle[i];
        if (i >= row && middle[i - row] > m) m = middle[i - row];
        if (i + row < size && middle[i + row] > m) m = middle[i + row];
        to[i] = m;
      }
    } else {
      for (let y = 0, i = 0; y < height; y++) {
        const end = i + row;
        for (let start = i; i < end; i++) {
          let m = from[i];
          if (i - 3 >= start && from[i - 3] > m) m = from[i - 3];
          if (i + 3 < end && from[i + 3] > m) m = from[i + 3];
          if (i >= row && from[i - row] > m) m = from[i - row];
          if (i + row < size && from[i + row] > m) m = from[i + row];
          to[i] = m;
        }
      }
    }
    const swap = from;
    from = to;
    to = swap;
  }
  const out = new Uint8ClampedArray(size);
  if (dilate) out.set(from);
  else for (let i = 0; i < size; i++) out[i] = 255 - from[i];
  return out;
}

/** outline_expansion: blend an eroded and a dilated copy of the image according to the weight map. */
function outlineExpansion(rgb: Uint8ClampedArray, lightness: Float32Array, width: number, height: number, thickness: number, patch: number): Uint8ClampedArray {
  const weight = expansionWeight(lightness, width, height, patch);
  const eroded = morph(rgb, width, height, thickness, false, true);
  const dilated = morph(rgb, width, height, thickness, true, true);
  const out = new Uint8ClampedArray(rgb.length);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i];
    const keep = sigmoid((w - 0.5) * 5) * 0.25; // a share of the original always stays
    for (let c = 0; c < 3; c++) {
      const mixed = eroded[i * 3 + c] * w + dilated[i * 3 + c] * (1 - w);
      out[i * 3 + c] = Math.floor(mixed * (1 - keep) + rgb[i * 3 + c] * keep);
    }
  }
  // Open then close with the plus-shaped kernel, to remove the specks the blend leaves.
  const opened = morph(out, width, height, thickness, false, false);
  const closed = morph(opened, width, height, thickness * 2, true, false);
  return morph(closed, width, height, thickness, false, false);
}

/** Box blur of one channel, horizontally then vertically, edges repeated. */
function boxBlur(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  const size = radius * 2 + 1;
  // One line of `length` values, `step` apart, starting at `base`.
  const line = (from: Float32Array, to: Float32Array, base: number, length: number, step: number) => {
    const first = from[base];
    const final = from[base + (length - 1) * step];
    let sum = first * (radius + 1);
    for (let k = 1; k <= radius; k++) sum += k < length ? from[base + k * step] : final;
    for (let i = 0; i < length; i++) {
      to[base + i * step] = sum / size;
      const enter = i + radius + 1;
      const leave = i - radius;
      sum += (enter < length ? from[base + enter * step] : final) - (leave >= 0 ? from[base + leave * step] : first);
    }
  };
  const across = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) line(plane, across, y * width, width, 1);
  const out = new Float32Array(plane.length);
  for (let x = 0; x < width; x++) line(across, out, x, height, width);
  return out;
}

/**
 * The low frequencies of a channel: what the reference gets from five Gaussian blurs in a row
 * (kernel sizes 5 to 65), which together are one Gaussian of sigma ~ 12.
 * port: approximated by three box blurs, the usual stand-in for a Gaussian.
 */
function lowFrequencies(plane: Float32Array, width: number, height: number): Float32Array {
  // Three box blurs of radius r have variance r(r+1); r = 11 gives sigma ~ 11.5.
  const RADIUS = 11;
  let out = plane;
  for (let k = 0; k < 3; k++) out = boxBlur(out, width, height, RADIUS);
  return out;
}

/**
 * match_color: bring the processed image back to the colours of the original. First the overall
 * mean and spread in Lab, then the low frequencies of each RGB channel are replaced by the original's.
 */
function matchColor(processed: Uint8ClampedArray, original: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const count = width * height;
  // Lab in the 0..1 scale the reference works in (OpenCV's 8-bit Lab divided by 255), all channels pooled.
  const toUnit = (rgb: Uint8ClampedArray) => {
    const lab = new Float32Array(count * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      srgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], tmp);
      lab[i * 3] = tmp[0] / 100;
      lab[i * 3 + 1] = (tmp[1] + 128) / 255;
      lab[i * 3 + 2] = (tmp[2] + 128) / 255;
    }
    return lab;
  };
  const stats = (lab: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < lab.length; i++) sum += lab[i];
    const mean = sum / lab.length;
    let squares = 0;
    for (let i = 0; i < lab.length; i++) squares += (lab[i] - mean) * (lab[i] - mean);
    return { mean, deviation: Math.sqrt(squares / lab.length) };
  };
  const lab = toUnit(processed);
  const from = stats(lab);
  const to = stats(toUnit(original));
  const matched = new Uint8ClampedArray(count * 3);
  for (let i = 0; i < count; i++) {
    const unit = (c: number) => Math.min(1, Math.max(0, ((lab[i * 3 + c] - from.mean) / (from.deviation || 1)) * to.deviation + to.mean));
    labToSrgb(unit(0) * 100, unit(1) * 255 - 128, unit(2) * 255 - 128, matched, i * 3);
  }

  const out = new Uint8ClampedArray(count * 3);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) {
      a[i] = matched[i * 3 + c];
      b[i] = original[i * 3 + c];
    }
    const lowA = lowFrequencies(a, width, height);
    const lowB = lowFrequencies(b, width, height);
    for (let i = 0; i < count; i++) out[i * 3 + c] = a[i] - lowA[i] + lowB[i];
  }
  return out;
}

/**
 * contrast_based_downscale: one output pixel per `patch` x `patch` block. Its lightness is the
 * block's darkest or brightest pixel when the block is skewed that way, else the centre pixel;
 * its colour (a, b) is the block's median.
 */
function contrastDownscale(rgb: Uint8ClampedArray, width: number, height: number, patch: number): Uint8ClampedArray {
  const count = width * height;
  const L = new Float32Array(count);
  const A = new Float32Array(count);
  const B = new Float32Array(count);
  const tmp = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    srgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], tmp);
    L[i] = tmp[0];
    A[i] = tmp[1];
    B[i] = tmp[2];
  }
  const middle = (patch * patch) >> 1;
  const findPixel = (values: Float32Array, n: number) => {
    const mid = values[middle];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;
    const max = maxOf(values, n);
    const min = minOf(values, n);
    const median = lowerMedian(values, n); // sorts `values`: everything else is read before this
    if (median < mean && max - median > median - min) return min;
    if (median > mean && max - median < median - min) return max;
    return mid;
  };
  const outL = perBlock(L, width, height, patch, patch, findPixel);
  const outA = perBlock(A, width, height, patch, patch, lowerMedian);
  const outB = perBlock(B, width, height, patch, patch, lowerMedian);
  const out = new Uint8ClampedArray(outL.length * 3);
  for (let i = 0; i < outL.length; i++) labToSrgb(outL[i], outA[i], outB[i], out, i * 3);
  return out;
}

/** RGBA pixels of `width` x `height` pixelized to `toWidth` x `toHeight` with PixelOE. */
export function pixelOE(pixels: Uint8ClampedArray, width: number, height: number, toWidth: number, toHeight: number, settings: PixelOESettings): Uint8ClampedArray {
  const patch = PATCHES.find((p) => toWidth * toHeight * p * p <= MAX_WORKING_PIXELS) ?? PATCHES[PATCHES.length - 1];
  const w = toWidth * patch;
  const h = toHeight * patch;
  // port: the reference resizes with OpenCV's bilinear; here it is our bilinear, which averages when shrinking.
  const working = resample(pixels, width, height, w, h, 'bilinear');

  const count = w * h;
  const original = new Uint8ClampedArray(count * 3);
  const lightness = new Float32Array(count);
  const tmp = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    original[i * 3] = working[i * 4];
    original[i * 3 + 1] = working[i * 4 + 1];
    original[i * 3 + 2] = working[i * 4 + 2];
    srgbToLab(working[i * 4], working[i * 4 + 1], working[i * 4 + 2], tmp);
    lightness[i] = tmp[0] / 100;
  }

  const thickness = Math.max(0, Math.min(MAX_THICKNESS, Math.round(settings.thickness)));
  const expanded = thickness > 0 ? outlineExpansion(original, lightness, w, h, thickness, patch) : original;
  const small = contrastDownscale(matchColor(expanded, original, w, h), w, h, patch);

  // port: the reference has no transparency. Each output pixel takes the average alpha of its block.
  const out = new Uint8ClampedArray(toWidth * toHeight * 4);
  for (let y = 0; y < toHeight; y++) {
    for (let x = 0; x < toWidth; x++) {
      let alpha = 0;
      for (let dy = 0; dy < patch; dy++) for (let dx = 0; dx < patch; dx++) alpha += working[((y * patch + dy) * w + x * patch + dx) * 4 + 3];
      const to = (y * toWidth + x) * 4;
      out[to] = small[(y * toWidth + x) * 3];
      out[to + 1] = small[(y * toWidth + x) * 3 + 1];
      out[to + 2] = small[(y * toWidth + x) * 3 + 2];
      out[to + 3] = alpha / (patch * patch);
    }
  }
  return out;
}
