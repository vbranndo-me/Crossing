import type { BrandId } from '../threads/brands.ts';
import type { ChartStats, ColorAnalysis, PipelineSettings, SimplifiedColor, Stage } from './pipeline.ts';
import type { ConvertJob, ConvertReply } from './worker.ts';

/** What a stage produces: still an image (size, adjust) or already a chart (colors, cleanup). */
export type StageOutput =
  | { width: number; height: number; pixels: Uint8ClampedArray; palette?: SimplifiedColor[] }
  | { width: number; height: number; cells: Uint16Array; stats: ChartStats };

export interface ConvertRequest {
  image: Blob;
  /** Part of the image to use, in its own pixels. */
  crop: { x: number; y: number; width: number; height: number };
  /** Size of the chart, in stitches. */
  width: number;
  height: number;
  brand: BrandId;
  settings: PipelineSettings;
  upTo: Stage;
}

export interface Converter {
  /**
   * Run the pipeline up to a stage. Only the latest request matters: `onDone` is not called for
   * a request that a newer one has replaced. null = the image could not be converted.
   * A request that ends on "simplify" is followed, a little later, by the colour analysis.
   */
  request(request: ConvertRequest, onDone: (output: StageOutput | null) => void, onAnalysis?: (analysis: ColorAnalysis) => void): void;
  dispose(): void;
}

/** A worker that converts one image at a time, always working towards the most recent request. */
export function createConverter(): Converter {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let latest = 0;
  let sent: Blob | null = null;
  let done: ((output: StageOutput | null) => void) | null = null;
  let analysed: ((analysis: ColorAnalysis) => void) | null = null;
  /** The next request, held back while the worker is busy so settings dragged quickly do not queue up. */
  let waiting: ConvertJob | null = null;
  let busy = false;

  const post = (job: ConvertJob) => {
    busy = true;
    worker.postMessage(job);
  };

  worker.onmessage = (e: MessageEvent<ConvertReply>) => {
    const reply = e.data;
    if ('analysis' in reply) {
      if (reply.id === latest) analysed?.(reply.analysis);
      return;
    }
    busy = false;
    if (waiting) {
      const next = waiting;
      waiting = null;
      post(next);
    }
    if (reply.id !== latest) return;
    if (!reply.ok) done?.(null);
    else if ('cells' in reply) done?.({ width: reply.width, height: reply.height, cells: reply.cells, stats: reply.stats });
    else done?.({ width: reply.width, height: reply.height, pixels: reply.pixels, palette: reply.palette });
  };
  worker.onerror = () => {
    busy = false;
    done?.(null);
  };

  return {
    request({ image, ...rest }, onDone, onAnalysis) {
      done = onDone;
      analysed = onAnalysis ?? null;
      const job: ConvertJob = { id: ++latest, ...rest };
      // A job that was waiting may have been the one carrying the image: it is dropped, so resend.
      if (image !== sent || waiting?.image) job.image = image;
      sent = image;
      if (busy) waiting = job;
      else post(job);
    },
    dispose() {
      done = null;
      analysed = null;
      worker.terminate();
    },
  };
}
