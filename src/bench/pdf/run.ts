// B4: PDF export. Run with `npm run bench:pdf`.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { startSite } from '../../../scripts/browser.ts';
import { QUICK, ROOT, RUNS, SIZES, log, machineInfo, writeRaw } from '../../../scripts/lib.ts';
import { spread } from '../stats.ts';
import type { PdfBench } from './main.ts';

declare const bench: PdfBench;

const PALETTE = 500;
const TIMEOUT_MS = 240_000;
const HEAP_LIMIT_MB = 4096;
const sizes = QUICK ? [200] : SIZES;
const tmp = resolve(ROOT, 'results/tmp');
mkdirSync(tmp, { recursive: true });

interface Run {
  totalMs: number;
  firstPageMs: number;
  fileBytes: number;
  pageCount: number;
  chartPages: number;
  progressEvents: number;
  peakHeapBytes: number;
  peakRssBytes: number;
}

/** One export in a fresh process (host.ts), which runs it in a worker thread. */
function exportOnce(size: number, strategy: string, out = ''): Promise<Run> {
  return new Promise((done, fail) => {
    const child = fork(fileURLToPath(new URL('./host.ts', import.meta.url)), [String(size), strategy, String(PALETTE), String(HEAP_LIMIT_MB), out]);
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`timeout after ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    child.on('message', (m: Run & { type: string; message?: string }) => {
      clearTimeout(timer);
      if (m.type === 'done') done(m);
      else fail(new Error(m.message));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) fail(new Error(`host exited with code ${code}`));
    });
  });
}

const results = [];
let naiveRuns = RUNS;
for (const size of sizes) {
  for (const strategy of ['naive', 'stream']) {
    const runs = strategy === 'naive' ? naiveRuns : RUNS;
    const all: Run[] = [];
    let failed: string | undefined;
    try {
      if (runs > 1) await exportOnce(size, strategy); // warm-up (module load, file cache)
      for (let k = 0; k < runs; k++) {
        const out = k === runs - 1 ? resolve(tmp, `chart-${size}-${strategy}.pdf`) : undefined;
        all.push(await exportOnce(size, strategy, out));
      }
    } catch (e) {
      failed = (e as Error).message;
    }
    if (failed) {
      log(`${size} ${strategy}: FAILED (${failed})`);
      results.push({ size, strategy, runs: all.length, failed });
      continue;
    }
    const pick = (k: keyof Run) => spread(all.map((r) => r[k]));
    const r = {
      size,
      strategy,
      runs,
      pageCount: all[0].pageCount,
      chartPages: all[0].chartPages,
      progressEvents: all[0].progressEvents,
      fileBytes: all[0].fileBytes,
      totalMs: pick('totalMs'),
      firstPageMs: pick('firstPageMs'),
      peakHeapBytes: pick('peakHeapBytes'),
      peakRssBytes: pick('peakRssBytes'),
    };
    results.push(r);
    log(
      `${size} ${strategy.padEnd(6)} ${(r.totalMs.median / 1000).toFixed(2)} s, first page ${r.firstPageMs.median.toFixed(0)} ms, ` +
        `${r.pageCount} pages, ${(r.fileBytes / 2 ** 20).toFixed(2)} MB file, peak heap ${(r.peakHeapBytes.median / 2 ** 20).toFixed(0)} MB, ` +
        `peak RSS ${(r.peakRssBytes.median / 2 ** 20).toFixed(0)} MB`,
    );
    // Once the naive baseline is this slow, a single run of the bigger sizes is enough.
    if (strategy === 'naive' && r.totalMs.median > 20_000) naiveRuns = 1;
  }
}

// Same export (stream strategy) inside a real Web Worker in Chromium.
const site = await startSite();
const page = await site.open('pdf');
await page.waitForFunction(() => 'bench' in window);
const browser = [];
for (const size of sizes) {
  await page.evaluate(([s, p]) => bench.run(s, p), [size, PALETTE]); // warm-up
  const all = [];
  for (let k = 0; k < RUNS; k++) all.push(await page.evaluate(([s, p]) => bench.run(s, p), [size, PALETTE]));
  const r = {
    size,
    strategy: 'stream',
    runs: RUNS,
    wallMs: spread(all.map((x) => x.wallMs)),
    firstPageMs: spread(all.map((x) => x.firstPageMs)),
    longestTaskMs: spread(all.map((x) => x.longestTaskMs)),
    pageCount: all[0].pageCount,
    fileBytes: all[0].fileBytes,
    progressEvents: all[0].progressEvents,
  };
  browser.push(r);
  log(`${size} web worker: ${(r.wallMs.median / 1000).toFixed(2)} s, longest main-thread task ${r.longestTaskMs.median.toFixed(0)} ms`);
}
const info = await site.info();
await site.close();

writeRaw('pdf', {
  bench: 'B4 pdf',
  date: new Date().toISOString(),
  quick: QUICK,
  machine: machineInfo(info),
  config: { palette: PALETTE, cellsPerPage: 50, runs: RUNS, heapLimitMB: HEAP_LIMIT_MB, timeoutMs: TIMEOUT_MS },
  results,
  browser,
});
