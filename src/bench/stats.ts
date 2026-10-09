export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (values: number[]) => percentile(values, 0.5);

export interface Spread {
  median: number;
  min: number;
  max: number;
  runs: number;
}

/** Median and spread across benchmark runs. */
export function spread(values: number[]): Spread {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values), runs: values.length };
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  avgFps: number;
  /** Frames longer than 20 ms. */
  dropped: number;
}

export function frameStats(deltas: number[]): FrameStats {
  const total = deltas.reduce((a, b) => a + b, 0);
  return {
    frames: deltas.length,
    p50: percentile(deltas, 0.5),
    p95: percentile(deltas, 0.95),
    p99: percentile(deltas, 0.99),
    avgFps: deltas.length ? (deltas.length * 1000) / total : 0,
    dropped: deltas.filter((d) => d > 20).length,
  };
}
