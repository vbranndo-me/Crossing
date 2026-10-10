import { ciede2000, srgbToLab } from '../core/color.ts';
import { SYMBOLS } from '../core/palette.ts';
import type { Palette, PaletteEntry } from '../core/palette.ts';
import anchorCsv from './data/anchor.csv?raw';
import dmcCsv from './data/dmc.csv?raw';

/** The thread brands a chart can use. Adding one is a CSV in ./data and an entry in BRANDS. */
export type BrandId = 'dmc' | 'anchor';

export interface ThreadColor {
  /** The number printed on the skein, as text (some are not numbers: "B5200", "ECRU"). */
  code: string;
  name: string;
  rgb: [number, number, number];
}

export interface Brand {
  id: BrandId;
  name: string;
  /** The catalogue, in the order it is listed and numbered in the app. */
  colors: ThreadColor[];
  /** Codes of the colours a new chart starts with: the drawing colour and the two ends of a gradient. */
  defaults: { draw: string; gradient: [string, string] };
}

/**
 * Read a thread table: a CSV with a header line and the columns code, name, hex, R, G, B
 * (anything after that is ignored). Sorted by code, so the order does not depend on the file:
 * codes that are not numbers first, then by number.
 */
function parseTable(csv: string): ThreadColor[] {
  const colors = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
    .filter((cells) => cells.length >= 6 && cells[0] !== '')
    .map((cells): ThreadColor => ({ code: cells[0].trim(), name: cells[1].trim(), rgb: [Number(cells[3]), Number(cells[4]), Number(cells[5])] }));
  const numeric = (code: string) => (/^\d+$/.test(code) ? Number(code) : -1);
  return colors.sort((a, b) => numeric(a.code) - numeric(b.code) || a.code.localeCompare(b.code));
}

export const BRANDS: Record<BrandId, Brand> = {
  dmc: { id: 'dmc', name: 'DMC', colors: parseTable(dmcCsv), defaults: { draw: '310', gradient: ['310', 'BLANC'] } },
  anchor: { id: 'anchor', name: 'Anchor', colors: parseTable(anchorCsv), defaults: { draw: '403', gradient: ['403', '2'] } },
};

export const BRAND_IDS = Object.keys(BRANDS) as BrandId[];
export const DEFAULT_BRAND: BrandId = 'dmc';

/** A stored brand id, or the default if it is missing or unknown (charts saved before brands existed). */
export const brandOf = (id: unknown): BrandId => (typeof id === 'string' && id in BRANDS ? (id as BrandId) : DEFAULT_BRAND);

const palettes = new Map<BrandId, Palette>();

/** The palette table of a brand: index 0 is the empty cell, 1..size its colours in catalogue order. */
export function paletteFor(id: BrandId): Palette {
  let palette = palettes.get(id);
  if (!palette) {
    const brand = BRANDS[id];
    const size = brand.colors.length;
    const rgb = new Uint8Array((size + 1) * 3).fill(255, 0, 3);
    const lab = new Float64Array((size + 1) * 3);
    srgbToLab(255, 255, 255, lab, 0);
    const entries: PaletteEntry[] = [{ id: 0, brand: '', code: '', name: 'Empty', rgb: [255, 255, 255], lab: [lab[0], lab[1], lab[2]], symbol: '' }];
    brand.colors.forEach((color, k) => {
      const i = k + 1;
      rgb.set(color.rgb, i * 3);
      srgbToLab(color.rgb[0], color.rgb[1], color.rgb[2], lab, i * 3);
      entries.push({ id: i, brand: brand.name, code: color.code, name: color.name, rgb: color.rgb, lab: [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], symbol: SYMBOLS[k % SYMBOLS.length] });
    });
    palette = { size, entries, rgb, lab };
    palettes.set(id, palette);
  }
  return palette;
}

/** Palette index of a thread code in a brand, or `fallback` if the brand has no such code. */
export function indexOfCode(id: BrandId, code: string, fallback = 1): number {
  const index = paletteFor(id).entries.findIndex((e) => e.id !== 0 && e.code === code);
  return index > 0 ? index : fallback;
}

/** The palette indices a new chart starts with (see Brand.defaults). */
export function defaultColors(id: BrandId): { draw: number; gradient: [number, number] } {
  const { draw, gradient } = BRANDS[id].defaults;
  return { draw: indexOfCode(id, draw), gradient: [indexOfCode(id, gradient[0]), indexOfCode(id, gradient[1], 2)] };
}

/**
 * For every colour of one palette, the closest colour of another (CIEDE2000).
 * Indexed by palette index; 0 (empty) stays 0.
 */
export function nearestThreads(from: Palette, to: Palette): Uint16Array {
  const map = new Uint16Array(from.size + 1);
  for (let i = 1; i <= from.size; i++) {
    let best = 1;
    let bestDistance = Infinity;
    for (let j = 1; j <= to.size; j++) {
      const d = ciede2000(from.lab[i * 3], from.lab[i * 3 + 1], from.lab[i * 3 + 2], to.lab[j * 3], to.lab[j * 3 + 1], to.lab[j * 3 + 2]);
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
      }
    }
    map[i] = best;
  }
  return map;
}

/**
 * Translate palette indices saved with a chart into today's indices. `codes` is the thread code
 * each saved index stood for; a code the brand no longer has, or a chart saved without codes,
 * falls back to wrapping the index into the palette so nothing points outside it.
 */
export function indexMap(id: BrandId, codes: string[] | undefined, highest: number): Uint16Array {
  const palette = paletteFor(id);
  const byCode = new Map(palette.entries.slice(1).map((e) => [e.code, e.id]));
  const map = new Uint16Array(Math.max(highest, codes?.length ?? 0) + 1);
  for (let i = 1; i < map.length; i++) map[i] = (codes && byCode.get(codes[i])) ?? ((i - 1) % palette.size) + 1;
  return map;
}
