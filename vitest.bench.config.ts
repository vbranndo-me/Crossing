import { defineConfig } from 'vitest/config';

// B2 runs under Vitest in a forked Node process with manual GC, so heap deltas are measurable.
export default defineConfig({
  test: {
    include: ['src/bench/history/*.bench.ts'],
    pool: 'forks',
    execArgv: ['--expose-gc', '--max-old-space-size=12288'],
    testTimeout: 30 * 60 * 1000,
    fileParallelism: false,
  },
});
