// B3 harness. Driven by run.ts through window.bench.
import type { ConvertOptions } from '../../core/convert.ts';
import { median, spread } from '../stats.ts';
import { runJob } from './job.ts';
import type { Job, JobResult } from './job.ts';

export interface Case {
  /** File name under /images/. */
  image: string;
  size: number;
  paletteSize: number;
  options: ConvertOptions;
  /** Run in the Web Worker (V4) instead of on the main thread. */
  worker: boolean;
  runs: number;
  warmup: number;
}

const images = new Map<string, Blob>();
async function load(name: string): Promise<Blob> {
  if (!images.has(name)) images.set(name, await (await fetch(`/images/${name}`)).blob());
  return images.get(name)!;
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
function runInWorker(job: Job): Promise<JobResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(job);
  });
}

// Main-thread blocking: long tasks (> 50 ms) and the worst gap between 5 ms timer ticks.
let longTasks: number[] = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longTasks.push(e.duration);
}).observe({ entryTypes: ['longtask'] });
let maxGap = 0;
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
}, 5);

const bench = {
  async run(c: Case) {
    const job: Job = { image: await load(c.image), size: c.size, paletteSize: c.paletteSize, options: c.options };
    const exec = c.worker ? runInWorker : runJob;
    for (let k = 0; k < c.warmup; k++) await exec(job);
    // Let pending long-task entries from the warm-up be delivered before measuring.
    await new Promise((r) => setTimeout(r, 60));
    longTasks = [];
    maxGap = 0;
    lastTick = performance.now();
    const wall: number[] = [];
    const results: JobResult[] = [];
    for (let k = 0; k < c.runs; k++) {
      const t0 = performance.now();
      results.push(await exec(job));
      // For the worker this includes posting the job and receiving the result.
      wall.push(performance.now() - t0);
    }
    await new Promise((r) => setTimeout(r, 60));
    const stage = (k: keyof JobResult['stages']) => median(results.map((r) => r.stages[k]));
    const scale = results[0].rowStride; // v1 on a row sample: extrapolate the map stage
    const totals = results.map((r, k) => (scale > 1 ? r.totalMs + r.stages.map * (scale - 1) : wall[k]));
    return {
      totalMs: spread(totals),
      stages: { resize: stage('resize'), lab: stage('lab'), quantize: stage('quantize'), map: stage('map') * scale, dither: stage('dither') },
      extrapolated: scale > 1,
      rowStride: scale,
      meanDeltaE: results[0].meanDeltaE,
      usedColors: results[0].usedColors,
      longTasks: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
      maxTimerGapMs: maxGap,
    };
  },
};

export type ConvertBench = typeof bench;
(window as unknown as { bench: ConvertBench }).bench = bench;
