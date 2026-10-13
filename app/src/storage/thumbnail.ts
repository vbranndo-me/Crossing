import type { Grid } from '../core/grid.ts';
import type { Palette } from '../core/palette.ts';
import { drawLines, flatColor } from '../render/flat.ts';
import type { UpperLayers } from '../render/flat.ts';

const MAX_SIDE = 192;

/** Small PNG of the chart (every layer), for the library. null if the browser cannot make one. */
export async function makeThumbnail(grid: Grid, palette: Palette, upper?: UpperLayers): Promise<Blob | null> {
  try {
    const { width, height, cells } = grid;
    const image = new ImageData(width, height);
    const pixels = new Uint32Array(image.data.buffer);
    for (let i = 0; i < cells.length; i++) {
      const o = flatColor(i, cells, upper) * 3;
      pixels[i] = 0xff000000 | (palette.rgb[o + 2] << 16) | (palette.rgb[o + 1] << 8) | palette.rgb[o];
    }
    const full = new OffscreenCanvas(width, height);
    full.getContext('2d')!.putImageData(image, 0, 0);

    // Big charts are shrunk; small ones are stored at one pixel per stitch and enlarged on screen.
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const small = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const ctx = small.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, small.width, small.height);
    if (upper) drawLines(ctx, upper.backstitches, palette, small.width / width);
    return await small.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  }
}
