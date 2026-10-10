import { describe, expect, it } from 'vitest';
import { labToSrgb, srgbToLab } from './color.ts';

describe('labToSrgb', () => {
  it('undoes srgbToLab', () => {
    const lab = [0, 0, 0];
    const rgb = [0, 0, 0];
    for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [201, 0, 35], [12, 200, 90], [40, 60, 220], [128, 128, 128]]) {
      srgbToLab(r, g, b, lab);
      labToSrgb(lab[0], lab[1], lab[2], rgb);
      expect(rgb).toEqual([r, g, b]);
    }
  });
});
