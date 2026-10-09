// The conversion pipeline as run by both the main thread (V1-V3) and the worker (V4).
import { convert, meanDeltaE } from '../../core/convert.ts';
import type { ConvertOptions, StageTimes } from '../../core/convert.ts';
import { makePalette } from '../../core/palette.ts';
import type { Palette } from '../../core/palette.ts';

export interface Job {
  image: Blob;
  size: number;
  paletteSize: number;
  options: ConvertOptions;
}

export interface JobResult {
  totalMs: number;
  stages: StageTimes & { resize: number };
  rowStride: number;
  meanDeltaE: number;
  usedColors: number;
  cells: Uint16Array;
}

const palettes = new Map<number, Palette>();
export function paletteOf(size: number): Palette {
  if (!palettes.has(size)) palettes.set(size, makePalette(size));
  return palettes.get(size)!;
}

export async function runJob(job: Job): Promise<JobResult> {
  const { size } = job;
  const pal = paletteOf(job.paletteSize);
  const t0 = performance.now();
  // Decode + resize to one pixel per cell.
  const bitmap = await createImageBitmap(job.image, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  const ctx = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const resize = performance.now() - t0;
  const r = convert(rgba, size, size, pal, job.options);
  const totalMs = performance.now() - t0;
  // Quality check and colour count are not part of the timing.
  return {
    totalMs,
    stages: { resize, ...r.stages },
    rowStride: r.rowStride,
    meanDeltaE: meanDeltaE(rgba, size, size, r.cells, pal, r.rowStride),
    usedColors: new Set(r.cells).size - (r.rowStride > 1 ? 1 : 0),
    cells: r.cells,
  };
}
