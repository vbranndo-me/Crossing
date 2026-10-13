import type { Palette } from '../core/palette.ts';
import type { Backstitch } from '../edit/editor.ts';

/** The layers above the full stitches, as the editor (or a saved chart) holds them. */
export interface UpperLayers {
  quarters: Uint16Array | null;
  halves: Uint16Array | null;
  backstitches: readonly Backstitch[];
}

/**
 * Colour (palette index) of a cell in a picture with one pixel per stitch: its full stitch or,
 * where there is none, the first half or quarter stitch it has.
 */
export function flatColor(i: number, cells: Uint16Array, upper: UpperLayers | undefined): number {
  if (cells[i] !== 0 || !upper) return cells[i];
  const { halves, quarters } = upper;
  if (halves) {
    if (halves[i * 2] !== 0) return halves[i * 2];
    if (halves[i * 2 + 1] !== 0) return halves[i * 2 + 1];
  }
  if (quarters) for (let q = 0; q < 4; q++) if (quarters[i * 4 + q] !== 0) return quarters[i * 4 + q];
  return 0;
}

/** Draw the backstitch lines and French knots on a canvas where one stitch is `scale` pixels. */
export function drawLines(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, lines: readonly Backstitch[], palette: Palette, scale: number): void {
  ctx.lineWidth = Math.max(1, scale * 0.25);
  ctx.lineCap = 'round';
  for (const l of lines) {
    const color = `rgb(${palette.rgb[l.color * 3]},${palette.rgb[l.color * 3 + 1]},${palette.rgb[l.color * 3 + 2]})`;
    if (l.x0 === l.x1 && l.y0 === l.y1) {
      const r = Math.max(1, scale * 0.3);
      ctx.fillStyle = color;
      ctx.fillRect((l.x0 / 2) * scale - r / 2, (l.y0 / 2) * scale - r / 2, r, r);
      continue;
    }
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo((l.x0 / 2) * scale, (l.y0 / 2) * scale);
    ctx.lineTo((l.x1 / 2) * scale, (l.y1 / 2) * scale);
    ctx.stroke();
  }
}
