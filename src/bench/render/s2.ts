import { darkInk } from '../../core/palette.ts';
import { BACKGROUND, LINES_MIN_PX, SYMBOL_FONT, SYMBOL_MIN_PX, css } from './types.ts';
import type { Camera, RendererFactory } from './types.ts';

/**
 * S2 canvas 2D, culled + cached: cell colours live in an offscreen canvas at 1 px per cell and are
 * blitted scaled; lines and symbols are drawn only for visible cells (symbols from 12 px per cell);
 * edits repaint only their dirty rectangle.
 */
export const createS2: RendererFactory = (canvas, grid, palette) => {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const { width, height, cells } = grid;
  const symbol = palette.entries.map((e) => e.symbol);
  const dark = palette.entries.map((_, i) => darkInk(palette, i));
  const fill = palette.entries.map((_, i) => css(palette, i));

  // Base layer: palette index -> packed ABGR pixel.
  const base = new OffscreenCanvas(width, height);
  const baseCtx = base.getContext('2d', { alpha: false })!;
  const lut = new Uint32Array(palette.size + 1);
  for (let i = 0; i <= palette.size; i++) {
    lut[i] = 0xff000000 | (palette.rgb[i * 3 + 2] << 16) | (palette.rgb[i * 3 + 1] << 8) | palette.rgb[i * 3];
  }
  const image = new ImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);
  const rebuild = () => {
    for (let i = 0; i < cells.length; i++) pixels[i] = lut[cells[i]];
    baseCtx.putImageData(image, 0, 0);
  };
  rebuild();

  /** Draw cells [x0,x1) x [y0,y1), already clamped to the grid. */
  const drawCells = (cam: Camera, x0: number, y0: number, x1: number, y1: number) => {
    if (x1 <= x0 || y1 <= y0) return;
    const s = cam.scale;
    const left = (x0 - cam.x) * s;
    const top = (y0 - cam.y) * s;
    const right = (x1 - cam.x) * s;
    const bottom = (y1 - cam.y) * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, x0, y0, x1 - x0, y1 - y0, left, top, right - left, bottom - top);

    if (s >= LINES_MIN_PX) {
      for (const bold of [false, true]) {
        ctx.beginPath();
        for (let x = x0; x <= x1; x++) {
          if ((x % 10 === 0) !== bold) continue;
          const px = Math.round((x - cam.x) * s) + 0.5;
          ctx.moveTo(px, top);
          ctx.lineTo(px, bottom);
        }
        for (let y = y0; y <= y1; y++) {
          if ((y % 10 === 0) !== bold) continue;
          const py = Math.round((y - cam.y) * s) + 0.5;
          ctx.moveTo(left, py);
          ctx.lineTo(right, py);
        }
        ctx.strokeStyle = bold ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (s >= SYMBOL_MIN_PX) {
      ctx.font = `${s * 0.7}px ${SYMBOL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Two passes so fillStyle changes once per ink colour instead of once per cell.
      for (const pass of [true, false]) {
        ctx.fillStyle = pass ? '#000' : '#fff';
        for (let y = y0; y < y1; y++) {
          const py = (y - cam.y + 0.5) * s;
          for (let x = x0, i = y * width + x0; x < x1; x++, i++) {
            const v = cells[i];
            if (v !== 0 && dark[v] === pass) ctx.fillText(symbol[v], (x - cam.x + 0.5) * s, py);
          }
        }
      }
    }
  };

  const visible = (cam: Camera) => ({
    x0: Math.max(0, Math.floor(cam.x)),
    y0: Math.max(0, Math.floor(cam.y)),
    x1: Math.min(width, Math.ceil(cam.x + canvas.width / cam.scale)),
    y1: Math.min(height, Math.ceil(cam.y + canvas.height / cam.scale)),
  });

  let dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  return {
    render(cam) {
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const v = visible(cam);
      drawCells(cam, v.x0, v.y0, v.x1, v.y1);
      dirty = null;
    },
    cellChanged(index) {
      const x = index % width;
      const y = (index - x) / width;
      baseCtx.fillStyle = fill[cells[index]];
      baseCtx.fillRect(x, y, 1, 1);
      if (!dirty) dirty = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
      else {
        dirty.x0 = Math.min(dirty.x0, x);
        dirty.y0 = Math.min(dirty.y0, y);
        dirty.x1 = Math.max(dirty.x1, x + 1);
        dirty.y1 = Math.max(dirty.y1, y + 1);
      }
    },
    flush(cam) {
      if (!dirty) return;
      const v = visible(cam);
      const x0 = Math.max(v.x0, dirty.x0);
      const y0 = Math.max(v.y0, dirty.y0);
      const x1 = Math.min(v.x1, dirty.x1);
      const y1 = Math.min(v.y1, dirty.y1);
      dirty = null;
      if (x1 <= x0 || y1 <= y0) return;
      const s = cam.scale;
      // Clip one pixel wider so the shared grid lines on the edge are redrawn whole.
      ctx.save();
      ctx.beginPath();
      ctx.rect((x0 - cam.x) * s - 1, (y0 - cam.y) * s - 1, (x1 - x0) * s + 3, (y1 - y0) * s + 3);
      ctx.clip();
      drawCells(cam, Math.max(v.x0, x0 - 1), Math.max(v.y0, y0 - 1), Math.min(v.x1, x1 + 1), Math.min(v.y1, y1 + 1));
      ctx.restore();
    },
    gridChanged: rebuild,
    // Offscreen canvas backing store + the ImageData used to rebuild it.
    layerBytes: () => width * height * 4 * 2,
  };
};
