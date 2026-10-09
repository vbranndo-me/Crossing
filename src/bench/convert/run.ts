// B3: image to pattern conversion. Run with `npm run bench:convert`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startSite } from '../../../scripts/browser.ts';
import { QUICK, ROOT, RUNS, SIZES, log, machineInfo, writeRaw } from '../../../scripts/lib.ts';
import type { ConvertOptions } from '../../core/convert.ts';
import type { Case, ConvertBench } from './main.ts';

declare const bench: ConvertBench;

const dir = resolve(ROOT, 'fixtures/images');
if (!existsSync(resolve(dir, 'noise.png'))) execFileSync(process.execPath, ['scripts/make-fixtures.ts'], { cwd: ROOT, stdio: 'inherit' });
// Synthetic fixtures plus any real photo dropped in as photo-*.jpg.
const IMAGES = readdirSync(dir).filter((f) => /^(gradient|noise|flat)\.png$|^photo-.*\.jpe?g$/i.test(f));
const PALETTES = QUICK ? [60] : [60, 500, 1000];
const sizes = QUICK ? [200] : SIZES;
/** Above this many CIEDE2000 calls the naive variant converts a row sample and is extrapolated. */
const MAX_NAIVE_OPS = 1e8;

interface Variant {
  name: string;
  options: ConvertOptions;
  worker?: boolean;
  /** The naive baseline is deterministic CPU work measured once, without warm-up. */
  single?: boolean;
}

const VARIANTS: Variant[] = [
  { name: 'v1 naive', options: { variant: 'v1', maxNaiveOps: MAX_NAIVE_OPS }, single: true },
  { name: 'v2 cache', options: { variant: 'v2' } },
  { name: 'v3 n=16', options: { variant: 'v3', n: 16 } },
  { name: 'v3 n=32', options: { variant: 'v3', n: 32 } },
  { name: 'v3 n=64', options: { variant: 'v3', n: 64 } },
  { name: 'v3 n=32 kmeans', options: { variant: 'v3', n: 32, quantizer: 'kmeans' } },
  { name: 'v3 n=32 dither', options: { variant: 'v3', n: 32, dither: true } },
  { name: 'v4 worker n=32', options: { variant: 'v3', n: 32 }, worker: true },
  { name: 'v4 worker n=64', options: { variant: 'v3', n: 64 }, worker: true },
  { name: 'v4 worker n=32 dither', options: { variant: 'v3', n: 32, dither: true }, worker: true },
];

const site = await startSite();
const page = await site.open('convert');
await page.waitForFunction(() => 'bench' in window);
const results = [];

for (const size of sizes) {
  for (const paletteSize of PALETTES) {
    for (const image of IMAGES) {
      for (const v of VARIANTS) {
        const c: Case = {
          image,
          size,
          paletteSize,
          options: v.options,
          worker: !!v.worker,
          runs: v.single ? 1 : RUNS,
          warmup: v.single ? 0 : 1,
        };
        const r = await page.evaluate((c) => bench.run(c), c);
        results.push({ size, paletteSize, image, variant: v.name, ...r });
        log(
          `${size} pal ${paletteSize} ${image.padEnd(12)} ${v.name.padEnd(22)} ${r.totalMs.median.toFixed(1).padStart(9)} ms` +
            `${r.extrapolated ? '*' : ' '} dE ${r.meanDeltaE.toFixed(2)} colours ${r.usedColors} longest task ${r.longestTaskMs.toFixed(0)} ms`,
        );
      }
    }
  }
}

writeRaw('convert', {
  bench: 'B3 convert',
  date: new Date().toISOString(),
  quick: QUICK,
  machine: machineInfo(await site.info()),
  config: { images: IMAGES, palettes: PALETTES, sizes, runs: RUNS, maxNaiveOps: MAX_NAIVE_OPS, quantizer: 'median cut (default), k-means as a variant' },
  results,
});
await site.close();
