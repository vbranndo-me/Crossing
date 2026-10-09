import { darkInk } from '../../core/palette.ts';
import { BACKGROUND, SYMBOL_FONT, css } from './types.ts';
import type { RendererFactory } from './types.ts';

/** S1 naive: every frame, every cell of the grid gets a fillRect and a fillText. No culling, no cache. */
export const createS1: RendererFactory = (canvas, grid, palette) => {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const fill = palette.entries.map((_, i) => css(palette, i));
  const ink = palette.entries.map((_, i) => (darkInk(palette, i) ? '#000' : '#fff'));
  const symbol = palette.entries.map((e) => e.symbol);
  const { width, height, cells } = grid;

  const render = (cam: { x: number; y: number; scale: number }) => {
    const s = cam.scale;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${s * 0.7}px ${SYMBOL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0, i = 0; y < height; y++) {
      const py = (y - cam.y) * s;
      for (let x = 0; x < width; x++, i++) {
        const v = cells[i];
        const px = (x - cam.x) * s;
        ctx.fillStyle = fill[v];
        ctx.fillRect(px, py, s, s);
        if (v !== 0) {
          ctx.fillStyle = ink[v];
          ctx.fillText(symbol[v], px + s / 2, py + s / 2);
        }
      }
    }
  };

  return { render, cellChanged() {}, flush: render, gridChanged() {}, layerBytes: () => 0 };
};
