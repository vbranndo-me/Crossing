// B1: rendering and interaction. Run with `npm run bench:render`.
import { startSite } from '../../../scripts/browser.ts';
import { QUICK, RUNS, SIZES, log, machineInfo, writeRaw } from '../../../scripts/lib.ts';
import { spread } from '../stats.ts';
import type { RenderBench } from './main.ts';

declare const bench: RenderBench;

const STRATEGIES = (process.env.BENCH_STRATEGIES ?? 's1,s2,s3').split(',');
const ZOOMS = [2, 8, 16, 32];
// 12 px is an extra pan point: the smallest cell size at which symbols are drawn (most symbols on screen).
const PAN_ZOOMS = [2, 8, 12, 16, 32];
const DURATION = QUICK ? 1000 : 5000;
const WARMUP = QUICK ? 200 : 500;
const STROKES = QUICK ? 50 : 500;
const PAINT_CAP = QUICK ? 2000 : 8000;
const PALETTE = 500;

type Metrics = Record<string, number>;

const site = await startSite();
const results = [];

async function runOnce(strategy: string, size: number): Promise<Metrics> {
  const page = await site.open('render', { strategy, size, palette: PALETTE });
  await page.waitForFunction(() => 'bench' in window);
  const m: Metrics = {};
  const open = await page.evaluate(() => bench.open());
  m.firstFrameMs = open.firstFrameMs;
  m.layerMB = open.layerMB;
  m.heapAfterOpenMB = open.heapMB;
  for (const z of PAN_ZOOMS) {
    const pan = await page.evaluate(([z, d, w]) => bench.pan(z, d, w), [z, DURATION, WARMUP]);
    m[`pan${z}.p50`] = pan.p50;
    m[`pan${z}.p95`] = pan.p95;
    m[`pan${z}.p99`] = pan.p99;
    m[`pan${z}.fps`] = pan.avgFps;
    m[`pan${z}.dropped`] = pan.dropped;
    m[`pan${z}.frames`] = pan.frames;
    m[`pan${z}.cpuP95`] = pan.cpuP95;
    m[`pan${z}.heapMB`] = pan.heapMB;
  }
  const zoom = await page.evaluate(([d, w]) => bench.zoom(d, w), [DURATION, WARMUP]);
  m['zoom.p50'] = zoom.p50;
  m['zoom.p95'] = zoom.p95;
  m['zoom.p99'] = zoom.p99;
  m['zoom.fps'] = zoom.avgFps;
  m['zoom.dropped'] = zoom.dropped;
  m['zoom.frames'] = zoom.frames;
  m['zoom.cpuP95'] = zoom.cpuP95;
  m['zoom.heapMB'] = zoom.heapMB;
  for (const z of ZOOMS) {
    const paint = await page.evaluate(([z, s, c]) => bench.paint(z, s, c), [z, STROKES, PAINT_CAP]);
    m[`paint${z}.p50`] = paint.p50;
    m[`paint${z}.p95`] = paint.p95;
    m[`paint${z}.max`] = paint.max;
    m[`paint${z}.strokes`] = paint.strokes;
  }
  const replace = await page.evaluate(() => bench.replace(5));
  m.replaceMs = replace.median;
  m.replaceMaxMs = replace.max;
  await page.close();
  return m;
}

for (const strategy of STRATEGIES) {
  for (const size of SIZES) {
    // The naive baseline needs seconds per frame on big grids: one run is enough to reject it.
    const runs = strategy === 's1' && size >= 500 ? 1 : RUNS;
    if (runs > 1) {
      // Throwaway page load so shader / font caches are warm for the measured runs.
      const page = await site.open('render', { strategy, size, palette: PALETTE });
      await page.waitForFunction(() => 'bench' in window);
      await page.evaluate(() => bench.open());
      await page.close();
    }
    const all: Metrics[] = [];
    for (let k = 0; k < runs; k++) {
      all.push(await runOnce(strategy, size));
      const m = all[k];
      log(
        `${strategy} ${size} run ${k + 1}/${runs}: open ${m.firstFrameMs.toFixed(0)} ms, pan p95 ` +
          `${PAN_ZOOMS.map((z) => m[`pan${z}.p95`].toFixed(1)).join('/')} ms, zoom p95 ${m['zoom.p95'].toFixed(1)} ms, paint p95 ` +
          `${ZOOMS.map((z) => m[`paint${z}.p95`].toFixed(1)).join('/')} ms, replace ${m.replaceMs.toFixed(0)} ms`,
      );
    }
    const metrics = Object.fromEntries(Object.keys(all[0]).map((key) => [key, spread(all.map((m) => m[key]))]));
    results.push({ strategy, size, runs, metrics });
  }
}

writeRaw(process.env.BENCH_ANGLE ? `render-${process.env.BENCH_ANGLE}` : 'render', {
  bench: 'B1 render',
  date: new Date().toISOString(),
  quick: QUICK,
  machine: machineInfo(await site.info()),
  config: { zooms: ZOOMS, panZooms: PAN_ZOOMS, durationMs: DURATION, warmupMs: WARMUP, strokes: STROKES, paintCapMs: PAINT_CAP, palette: PALETTE, runs: RUNS },
  results,
});
await site.close();
