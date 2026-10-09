// B4 worker (Node worker_threads): one export per worker, so every run starts from a clean heap.
import { writeFileSync } from 'node:fs';
import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { makePatternGrid } from '../../core/grid.ts';
import { makePalette } from '../../core/palette.ts';
import { exportPdf } from '../../core/pdf.ts';
import type { PdfOptions } from '../../core/pdf.ts';

const { size, strategy, paletteSize, out } = workerData as { size: number; strategy: PdfOptions['strategy']; paletteSize: number; out?: string };

// The chart being exported is prepared before the clock starts.
const palette = makePalette(paletteSize);
const grid = makePatternGrid(size, size, paletteSize);

const heap = () => {
  const h = v8.getHeapStatistics();
  return h.used_heap_size + h.external_memory;
};
const baseline = heap();
let peak = baseline;
let progressEvents = 0;

const t0 = performance.now();
const result = await exportPdf(grid, palette, { strategy }, (p) => {
  peak = Math.max(peak, heap());
  progressEvents++;
  parentPort!.postMessage({ type: 'progress', ...p });
});
const totalMs = performance.now() - t0;
peak = Math.max(peak, heap());
if (out) writeFileSync(out, result.bytes);

parentPort!.postMessage({
  type: 'done',
  totalMs,
  firstPageMs: result.firstPageMs,
  fileBytes: result.bytes.length,
  pageCount: result.pageCount,
  chartPages: result.chartPages,
  progressEvents,
  peakHeapBytes: peak - baseline,
});
