/**
 * Stage "size": scale an image to one pixel per stitch, with a choice of how source pixels are
 * combined. The choice shows: nearest keeps hard edges (right for pixel art, noisy for photos),
 * bilinear is soft, bicubic and Lanczos keep more detail and edge contrast.
 */
export const SAMPLINGS = ['nearest', 'bilinear', 'bicubic', 'lanczos'] as const;
export type Sampling = (typeof SAMPLINGS)[number];

interface Kernel {
  /** How far from its centre the kernel reaches, in output pixels. */
  support: number;
  weight(x: number): number;
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

const KERNELS: Record<Exclude<Sampling, 'nearest'>, Kernel> = {
  bilinear: { support: 1, weight: (x) => Math.max(0, 1 - Math.abs(x)) },
  // Catmull-Rom spline (the usual "bicubic").
  bicubic: {
    support: 2,
    weight: (x) => {
      const t = Math.abs(x);
      if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
      if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
      return 0;
    },
  },
  lanczos: { support: 3, weight: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

/**
 * For each output position along one axis: which source pixels contribute and how much.
 * When shrinking, the kernel is widened by the scale factor, so every source pixel under an
 * output pixel is taken into account (otherwise most of them would simply be skipped).
 */
function contributions(source: number, target: number, kernel: Kernel): { first: Int32Array; count: Int32Array; weights: Float32Array; taps: number } {
  const scale = source / target;
  const stretch = Math.max(1, scale);
  const reach = kernel.support * stretch;
  const taps = Math.ceil(reach) * 2 + 1;
  const first = new Int32Array(target);
  const count = new Int32Array(target);
  const weights = new Float32Array(target * taps);
  for (let i = 0; i < target; i++) {
    const centre = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(centre - reach));
    const hi = Math.min(source, Math.ceil(centre + reach));
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      const w = kernel.weight((j + 0.5 - centre) / stretch);
      weights[i * taps + (j - lo)] = w;
      sum += w;
    }
    for (let k = 0; k < hi - lo; k++) weights[i * taps + k] /= sum || 1;
    first[i] = lo;
    count[i] = hi - lo;
  }
  return { first, count, weights, taps };
}

/** RGBA pixels of `width` x `height` scaled to `toWidth` x `toHeight`. */
export function resample(pixels: Uint8ClampedArray, width: number, height: number, toWidth: number, toHeight: number, sampling: Sampling): Uint8ClampedArray {
  const out = new Uint8ClampedArray(toWidth * toHeight * 4);

  if (sampling === 'nearest') {
    // Each stitch takes the single source pixel at its centre.
    for (let y = 0; y < toHeight; y++) {
      const row = Math.min(height - 1, Math.floor(((y + 0.5) * height) / toHeight)) * width;
      for (let x = 0; x < toWidth; x++) {
        const from = (row + Math.min(width - 1, Math.floor(((x + 0.5) * width) / toWidth))) * 4;
        const to = (y * toWidth + x) * 4;
        out[to] = pixels[from];
        out[to + 1] = pixels[from + 1];
        out[to + 2] = pixels[from + 2];
        out[to + 3] = pixels[from + 3];
      }
    }
    return out;
  }

  // Two passes, across then down. Colours are weighted by their alpha (premultiplied) so that
  // transparent pixels do not bleed their hidden colour into their neighbours.
  const kernel = KERNELS[sampling];
  const across = contributions(width, toWidth, kernel);
  const middle = new Float32Array(toWidth * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < toWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const base = x * across.taps;
      for (let k = 0, from = (y * width + across.first[x]) * 4; k < across.count[x]; k++, from += 4) {
        const w = across.weights[base + k] * (pixels[from + 3] / 255);
        r += pixels[from] * w;
        g += pixels[from + 1] * w;
        b += pixels[from + 2] * w;
        a += w;
      }
      const to = (y * toWidth + x) * 4;
      middle[to] = r;
      middle[to + 1] = g;
      middle[to + 2] = b;
      middle[to + 3] = a;
    }
  }
  const down = contributions(height, toHeight, kernel);
  for (let y = 0; y < toHeight; y++) {
    const base = y * down.taps;
    for (let x = 0; x < toWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0, from = (down.first[y] * toWidth + x) * 4; k < down.count[y]; k++, from += toWidth * 4) {
        const w = down.weights[base + k];
        r += middle[from] * w;
        g += middle[from + 1] * w;
        b += middle[from + 2] * w;
        a += middle[from + 3] * w;
      }
      const to = (y * toWidth + x) * 4;
      if (a > 0) {
        // Uint8ClampedArray rounds and clamps: sharpening kernels overshoot a little.
        out[to] = r / a;
        out[to + 1] = g / a;
        out[to + 2] = b / a;
      }
      out[to + 3] = a * 255;
    }
  }
  return out;
}

/**
 * The largest part of a `width` x `height` image that has the proportions `toWidth` : `toHeight`.
 * `position` says where it sits in the room that is left: 0 = left / top, 1 = right / bottom.
 */
export function cropFor(width: number, height: number, toWidth: number, toHeight: number, position: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
  const wide = toWidth / toHeight > width / height;
  const w = wide ? width : Math.max(1, Math.round((height * toWidth) / toHeight));
  const h = wide ? Math.max(1, Math.round((width * toHeight) / toWidth)) : height;
  return { x: Math.round((width - w) * position.x), y: Math.round((height - h) * position.y), width: Math.min(w, width), height: Math.min(h, height) };
}
