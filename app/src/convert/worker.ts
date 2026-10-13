// Runs the conversion off the main thread, so the wizard stays responsive while settings change.
import { paletteFor } from '../threads/brands.ts';
import type { BrandId } from '../threads/brands.ts';
import { adjustPixels, analyzeColors, runPipeline, sizeImage } from './pipeline.ts';
import type { ChartStats, ColorAnalysis, PipelineSettings, SimplifiedColor, Stage } from './pipeline.ts';

export interface ConvertJob {
  id: number;
  /** The image file. Sent once; later jobs for the same image leave it out. */
  image?: Blob;
  /** Part of the image to use, in its own pixels. */
  crop: { x: number; y: number; width: number; height: number };
  /** Size of the chart, in stitches. */
  width: number;
  height: number;
  brand: BrandId;
  settings: PipelineSettings;
  /** Last stage to run: the reply is the image or chart as it comes out of that stage. */
  upTo: Stage;
}

export type ConvertReply =
  | { id: number; ok: true; width: number; height: number; pixels: Uint8ClampedArray; palette?: SimplifiedColor[] }
  | { id: number; ok: true; width: number; height: number; cells: Uint16Array; stats: ChartStats }
  | { id: number; ok: false }
  /** Sent after the reply to a job that ends on "simplify": what each number of colours would cost. */
  | { id: number; analysis: ColorAnalysis };

/** The image being converted, decoded once and reused while its settings change. */
let bitmap: ImageBitmap | null = null;
/** The pixels of the last crop asked for, at the image's own resolution. */
let cropped: { key: string; width: number; height: number; pixels: Uint8ClampedArray } | null = null;
/** The stage "size" output last asked for: most changes are to later stages and can start from here. */
let sized: { key: string; pixels: Uint8ClampedArray } | null = null;
/** The last colour analysis: it does not depend on most settings, so it is rarely worked out again. */
let analysed: { key: string; analysis: ColorAnalysis } | null = null;

self.onmessage = async (e: MessageEvent<ConvertJob>) => {
  const job = e.data;
  try {
    if (job.image) {
      bitmap?.close();
      bitmap = await createImageBitmap(job.image);
      cropped = null;
      sized = null;
    }
    if (!bitmap) throw new Error('no image');
    const { crop } = job;
    const cropKey = [crop.x, crop.y, crop.width, crop.height].join();
    if (!cropped || cropped.key !== cropKey) {
      // The canvas is only used to read the pixels out, unscaled; the scaling is ours (stage "size").
      const canvas = new OffscreenCanvas(crop.width, crop.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      cropped = { key: cropKey, width: crop.width, height: crop.height, pixels: ctx.getImageData(0, 0, crop.width, crop.height).data };
      sized = null;
    }
    const sizeKey = [cropKey, job.width, job.height, job.settings.size.method, job.settings.size.thickness].join();
    if (!sized || sized.key !== sizeKey) {
      sized = { key: sizeKey, pixels: sizeImage(cropped.pixels, cropped.width, cropped.height, job.width, job.height, job.settings.size) };
    }
    const result = runPipeline(sized.pixels, job.width, job.height, paletteFor(job.brand), job.settings, job.upTo);
    const base = { id: job.id, ok: true as const, width: job.width, height: job.height };
    if ('cells' in result) {
      self.postMessage({ ...base, ...result } satisfies ConvertReply, { transfer: [result.cells.buffer] });
    } else {
      // The sized pixels are kept here for the next job, so a copy is what gets sent.
      const pixels = result.pixels === sized.pixels ? new Uint8ClampedArray(result.pixels) : result.pixels;
      self.postMessage({ ...base, pixels, palette: result.palette } satisfies ConvertReply, { transfer: [pixels.buffer] });
    }
    const { adjust, simplify } = job.settings;
    if (job.upTo === 'simplify' && simplify.enabled) {
      const key = JSON.stringify([sizeKey, adjust, simplify.smooth, simplify.method]);
      if (analysed?.key !== key) analysed = { key, analysis: analyzeColors(adjustPixels(sized.pixels, adjust), job.width, job.height, simplify) };
      self.postMessage({ id: job.id, analysis: analysed.analysis } satisfies ConvertReply);
    }
  } catch {
    self.postMessage({ id: job.id, ok: false } satisfies ConvertReply);
  }
};
