import { rng } from './rng.ts';

/** A pattern: each cell is an index into the palette table (0 = empty). */
export interface Grid {
  width: number;
  height: number;
  cells: Uint16Array;
}

export function createGrid(width: number, height: number): Grid {
  return { width, height, cells: new Uint16Array(width * height) };
}

export interface FillResult {
  /** Changed cells as [start, length] pairs of row-contiguous runs. */
  runs: Uint32Array;
  count: number;
  /** The single value that was replaced. */
  prev: number;
}

/**
 * Scanline flood fill (4-connected). Stops once `maxCells` cells were changed,
 * so benchmarks can bound the size of an edit.
 */
export function floodFill(grid: Grid, start: number, value: number, maxCells = Infinity): FillResult {
  const { width: w, cells } = grid;
  const n = cells.length;
  const target = cells[start];
  if (target === value) return { runs: new Uint32Array(0), count: 0, prev: target };
  const stack: number[] = [start];
  const runs: number[] = [];
  let count = 0;
  while (stack.length > 0 && count < maxCells) {
    const i = stack.pop()!;
    if (cells[i] !== target) continue;
    const row = i - (i % w);
    let l = i;
    let r = i;
    while (l > row && cells[l - 1] === target) l--;
    while (r < row + w - 1 && cells[r + 1] === target) r++;
    if (count + (r - l + 1) > maxCells) r = l + (maxCells - count) - 1;
    cells.fill(value, l, r + 1);
    runs.push(l, r - l + 1);
    count += r - l + 1;
    for (let dy = -w; dy <= w; dy += 2 * w) {
      if (l + dy < 0 || l + dy >= n) continue;
      let inSpan = false;
      for (let j = l + dy, end = r + dy; j <= end; j++) {
        if (cells[j] === target) {
          if (!inSpan) {
            stack.push(j);
            inSpan = true;
          }
        } else {
          inSpan = false;
        }
      }
    }
  }
  return { runs: Uint32Array.from(runs), count, prev: target };
}

/**
 * Deterministic image-like test pattern: smooth regions (value noise) drawn from
 * `regionColors` palette entries, plus `speckle` fraction of cells using the whole palette.
 */
export function makePatternGrid(
  width: number,
  height: number,
  paletteSize: number,
  seed = 7,
  regionColors = 48,
  speckle = 0.05,
): Grid {
  const grid = createGrid(width, height);
  const rand = rng(seed);
  const L = 64;
  const lattice = new Float32Array(L * L);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const at = (x: number, y: number) => lattice[(y & (L - 1)) * L + (x & (L - 1))];
  const noise = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
  const k = Math.min(regionColors, paletteSize);
  const { cells } = grid;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (rand() < speckle) {
        cells[i] = 1 + Math.floor(rand() * paletteSize);
      } else {
        const v = 0.65 * noise(x / 28, y / 28) + 0.35 * noise(x / 7 + 31, y / 7 + 17);
        cells[i] = 1 + Math.min(k - 1, Math.floor(v * k));
      }
    }
  }
  return grid;
}
