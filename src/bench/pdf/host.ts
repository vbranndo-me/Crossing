// B4 host process: runs one export in a worker thread and reports the peak RSS of this fresh process.
import { Worker } from 'node:worker_threads';

const [size, strategy, paletteSize, heapLimitMB, out] = process.argv.slice(2);
const worker = new Worker(new URL('./node-worker.ts', import.meta.url), {
  workerData: { size: Number(size), strategy, paletteSize: Number(paletteSize), out: out || undefined },
  resourceLimits: { maxOldGenerationSizeMb: Number(heapLimitMB) },
});
worker.on('message', (m) => {
  if (m.type !== 'done') return;
  // maxRSS is the peak resident set of the whole process, in kilobytes (Node baseline included).
  process.send!({ ...m, peakRssBytes: process.resourceUsage().maxRSS * 1024 }, () => process.exit(0));
});
worker.on('error', (e: Error) => {
  process.send!({ type: 'error', message: e.message }, () => process.exit(1));
});
