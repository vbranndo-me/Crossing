import { describe, expect, it } from 'vitest';
import { BRANDS, BRAND_IDS, brandOf, defaultColors, indexMap, indexOfCode, nearestThreads, paletteFor } from './brands.ts';

describe('thread brands', () => {
  it('every brand has a palette with unique codes, and index 0 is the empty cell', () => {
    for (const id of BRAND_IDS) {
      const palette = paletteFor(id);
      expect(palette.size).toBe(BRANDS[id].colors.length);
      expect(palette.entries[0].code).toBe('');
      const codes = palette.entries.slice(1).map((e) => e.code);
      expect(new Set(codes).size).toBe(codes.length);
      expect(palette.entries[1].brand).toBe(BRANDS[id].name);
      expect(paletteFor(id)).toBe(palette); // built once
      for (const e of palette.entries) expect(e.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
    }
  });

  it('reads the two tables whole', () => {
    expect(paletteFor('dmc').size).toBe(489);
    expect(paletteFor('anchor').size).toBe(446);
    const dmc = paletteFor('dmc');
    expect(dmc.entries[indexOfCode('dmc', '310')]).toMatchObject({ name: 'Black', rgb: [12, 12, 12] });
    expect(dmc.entries[indexOfCode('dmc', '3866')].rgb).toEqual([221, 209, 190]);
    expect(paletteFor('anchor').entries[indexOfCode('anchor', '403')]).toMatchObject({ name: 'Black', rgb: [21, 20, 21] });
  });

  it('lists codes that are not numbers first, then the rest by number', () => {
    const dmc = paletteFor('dmc').entries.slice(1).map((e) => e.code);
    expect(dmc.slice(0, 5)).toEqual(['B5200', 'BLANC', 'ECRU', '01', '02']);
    // Codes that sit at the end of the file are sorted into place.
    expect(dmc.indexOf('504')).toBe(dmc.indexOf('503') + 1);
    const anchor = paletteFor('anchor').entries.slice(1).map((e) => Number(e.code));
    expect(anchor).toEqual([...anchor].sort((a, b) => a - b));
  });

  it('unknown or missing brand ids fall back to the default', () => {
    expect(brandOf('anchor')).toBe('anchor');
    expect(brandOf(undefined)).toBe('dmc');
    expect(brandOf('madeira')).toBe('dmc');
  });

  it('a new chart starts on black, with a black to white gradient', () => {
    for (const id of BRAND_IDS) {
      const palette = paletteFor(id);
      const { draw, gradient } = defaultColors(id);
      expect(palette.entries[draw].name).toBe('Black');
      expect(palette.entries[gradient[0]].name).toBe('Black');
      expect(palette.entries[gradient[1]].name).toBe('White');
    }
  });

  it('maps each colour to the closest one of the other brand', () => {
    const dmc = paletteFor('dmc');
    const anchor = paletteFor('anchor');
    const same = nearestThreads(dmc, dmc);
    expect([...same].every((v, i) => v === i)).toBe(true);
    const map = nearestThreads(dmc, anchor);
    expect(map[0]).toBe(0);
    expect([...map.slice(1)].every((v) => v >= 1 && v <= anchor.size)).toBe(true);
    expect(anchor.entries[map[indexOfCode('dmc', '310')]].code).toBe('403'); // black to black
    expect(anchor.entries[map[indexOfCode('dmc', 'BLANC')]].name).toMatch(/^White/);
  });

  it('saved indices follow their thread codes when the table changes', () => {
    const now = paletteFor('dmc');
    // A chart saved when the table was shorter and in another order.
    const saved = ['', '310', 'BLANC', '666', 'GONE'];
    const map = indexMap('dmc', saved, 4);
    expect(now.entries[map[1]].code).toBe('310');
    expect(now.entries[map[2]].code).toBe('BLANC');
    expect(now.entries[map[3]].code).toBe('666');
    expect(map[4]).toBeGreaterThan(0); // a code that no longer exists still lands inside the palette
    // No codes at all (charts from before they were saved): indices are kept, wrapped if too high.
    const bare = indexMap('dmc', undefined, 600);
    expect([bare[1], bare[489], bare[490]]).toEqual([1, 489, 1]);
  });
});
