import { srgbToLab } from './color.ts';
import { rng } from './rng.ts';

export interface PaletteEntry {
  id: number;
  brand: string;
  code: string;
  name: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  symbol: string;
}

/** Palette table. Index 0 is the empty cell; real colours are 1..size. */
export interface Palette {
  size: number;
  entries: PaletteEntry[];
  /** Flat copies for hot loops: 3 values per entry, indexed by entry id. */
  rgb: Uint8Array;
  lab: Float64Array;
}

const SYMBOL_RANGES: [number, number][] = [
  [0x21, 0x7e], // ASCII
  [0xa1, 0xac], // Latin-1
  [0xae, 0xff],
  [0x391, 0x3a1], // Greek
  [0x3a3, 0x3a9],
  [0x3b1, 0x3c9],
  [0x2701, 0x27be], // Dingbats
  [0x2190, 0x21ff], // Arrows
  [0x2200, 0x22ff], // Math operators
  [0x25a0, 0x25ff], // Geometric shapes
  [0x2500, 0x257f], // Box drawing
];

/** ~1000 distinct single-character chart symbols (synthetic stand-in for a real symbol font). */
export const SYMBOLS: string[] = SYMBOL_RANGES.flatMap(([lo, hi]) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCharCode(lo + i)),
);

/** Synthetic thread palette (stand-in for DMC + Anchor), deterministic for a given seed. */
export function makePalette(size: number, seed = 1): Palette {
  const rand = rng(seed);
  const rgb = new Uint8Array((size + 1) * 3);
  const lab = new Float64Array((size + 1) * 3);
  const entries: PaletteEntry[] = [];
  for (let i = 0; i <= size; i++) {
    const o = i * 3;
    if (i === 0) {
      rgb[0] = rgb[1] = rgb[2] = 255;
    } else {
      rgb[o] = Math.floor(rand() * 256);
      rgb[o + 1] = Math.floor(rand() * 256);
      rgb[o + 2] = Math.floor(rand() * 256);
    }
    srgbToLab(rgb[o], rgb[o + 1], rgb[o + 2], lab, o);
    entries.push({
      id: i,
      brand: i === 0 ? '' : i % 2 ? 'DMC' : 'Anchor',
      code: i === 0 ? '' : String(100 + i),
      name: i === 0 ? 'Empty' : `Synthetic ${i}`,
      rgb: [rgb[o], rgb[o + 1], rgb[o + 2]],
      lab: [lab[o], lab[o + 1], lab[o + 2]],
      symbol: i === 0 ? '' : SYMBOLS[(i - 1) % SYMBOLS.length],
    });
  }
  return { size, entries, rgb, lab };
}

/** True when a dark symbol reads better than a light one on this entry's colour. */
export function darkInk(p: Palette, index: number): boolean {
  return p.lab[index * 3] > 55;
}
