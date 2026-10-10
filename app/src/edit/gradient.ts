import { ciede2000 } from '../core/color.ts';
import type { Palette } from '../core/palette.ts';

/** Number of steps a gradient is cut into before matching threads. More than any ramp can use. */
const STEPS = 64;

/**
 * The threads to use along a gradient from one palette colour to another: the colours in
 * between are blended in Lab and each step takes the closest thread of the palette.
 * Returns one palette index per step, first to last.
 */
export function gradientRamp(palette: Palette, from: number, to: number): Uint16Array {
  const ramp = new Uint16Array(STEPS);
  const { lab } = palette;
  for (let k = 0; k < STEPS; k++) {
    const t = k / (STEPS - 1);
    const L = lab[from * 3] + (lab[to * 3] - lab[from * 3]) * t;
    const a = lab[from * 3 + 1] + (lab[to * 3 + 1] - lab[from * 3 + 1]) * t;
    const b = lab[from * 3 + 2] + (lab[to * 3 + 2] - lab[from * 3 + 2]) * t;
    let best = from;
    let bestDistance = Infinity;
    for (let i = 1; i <= palette.size; i++) {
      const d = ciede2000(L, a, b, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    ramp[k] = best;
  }
  // The ends are exactly the two colours asked for.
  ramp[0] = from;
  ramp[STEPS - 1] = to;
  return ramp;
}
