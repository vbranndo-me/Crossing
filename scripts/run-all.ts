// Runs every benchmark in sequence, then regenerates results/REPORT.md.
import { execFileSync } from 'node:child_process';
import { ROOT, log } from './lib.ts';

const node = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

const steps: [string, () => void][] = [
  ['B2 history', () => node(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.bench.config.ts'])],
  ['B1 render', () => node(['src/bench/render/run.ts'])],
  // Extra data point: the 1000x1000 grid with WebGL and canvas rasterized on the CPU (no usable GPU).
  ['B1 render, software GPU', () => node(['src/bench/render/run.ts'], { BENCH_ANGLE: 'swiftshader', BENCH_STRATEGIES: 's2,s3', BENCH_SIZES: '1000' })],
  ['B3 convert', () => node(['src/bench/convert/run.ts'])],
  ['B4 pdf', () => node(['src/bench/pdf/run.ts'])],
  ['report', () => node(['scripts/make-report.ts'])],
];

for (const [name, run] of steps) {
  log(`=== ${name} ===`);
  try {
    run();
  } catch (e) {
    // Keep going: the report marks whatever is missing.
    log(`${name} failed: ${(e as Error).message}`);
  }
}
