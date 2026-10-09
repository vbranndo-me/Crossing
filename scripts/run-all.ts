// Runs every benchmark in sequence, then regenerates results/REPORT.md.
import { execFileSync } from 'node:child_process';
import { ROOT, log } from './lib.ts';

const node = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

const steps: [string, () => void][] = [
  ['B2 history', () => node(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.bench.config.ts'])],
  ['B1 render', () => node(['src/bench/render/run.ts'])],
  // Extra data points for a machine with no usable GPU, 1000x1000 only: WebGL on the CPU, canvas 2D on the CPU.
  ['B1 render, WebGL on CPU', () => node(['src/bench/render/run.ts'], { BENCH_GPU: 'swiftshader', BENCH_STRATEGIES: 's3', BENCH_SIZES: '1000' })],
  ['B1 render, canvas on CPU', () => node(['src/bench/render/run.ts'], { BENCH_GPU: 'off', BENCH_STRATEGIES: 's2', BENCH_SIZES: '1000' })],
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
