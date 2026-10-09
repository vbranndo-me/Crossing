// B2: data model and history. Run with `npm run bench:history`.
import { expect, it } from 'vitest';
import { QUICK, RUNS, SIZES, machineInfo, writeRaw } from '../../../scripts/lib.ts';
import { createGrid, floodFill } from '../../core/grid.ts';
import type { Grid } from '../../core/grid.ts';
import { ObjectHistory, PackedHistory, SnapshotHistory, setCell } from '../../core/history.ts';
import type { History } from '../../core/history.ts';
import { rng } from '../../core/rng.ts';
import { percentile, spread } from '../stats.ts';

const SINGLE_EDITS = QUICK ? 1000 : 10_000;
const FILLS = QUICK ? 10 : 100;
const COLORS = 500;
/** Snapshots of a big grid cannot hold 10k actions in RAM, so the baseline gets fewer single edits. */
const SNAPSHOT_BUDGET = 400 * 2 ** 20;

const KINDS: Record<string, (g: Grid) => History> = {
  packed: () => new PackedHistory(),
  object: () => new ObjectHistory(),
  snapshot: (g) => new SnapshotHistory(g),
};

const gc = () => (globalThis as { gc?: () => void }).gc?.();
/** Live heap + ArrayBuffer bytes. ArrayBuffers are swept concurrently, so collect twice with a pause. */
const memory = async () => {
  gc();
  await new Promise((r) => setTimeout(r, 30));
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

async function runOnce(size: number, kind: string) {
  const rand = rng(42);
  const before = await memory();
  const grid = createGrid(size, size);
  const total = grid.cells.length;
  const history = KINDS[kind](grid);
  const singles = kind === 'snapshot' ? Math.min(SINGLE_EDITS, Math.floor(SNAPSHOT_BUDGET / grid.cells.byteLength)) : SINGLE_EDITS;

  let t = performance.now();
  for (let k = 0; k < singles; k++) {
    history.push(grid, setCell(grid, Math.floor(rand() * total), 1 + Math.floor(rand() * COLORS)));
  }
  const singleMs = performance.now() - t;

  const fillMs: number[] = [];
  let fillCells = 0;
  for (let k = 0; k < FILLS; k++) {
    const start = Math.floor(rand() * total);
    const value = 1 + Math.floor(rand() * COLORS);
    t = performance.now();
    const f = floodFill(grid, start, value, total / 2);
    if (f.count > 0) history.push(grid, { runs: f.runs, count: f.count, prev: f.prev, next: value });
    fillMs.push(performance.now() - t);
    fillCells += f.count;
  }
  const final = grid.cells.slice();
  const actions = history.length;
  const heldBytes = (await memory()) - before - final.byteLength - grid.cells.byteLength;

  t = performance.now();
  while (history.undo(grid));
  const undoMs = performance.now() - t;
  expect(grid.cells.every((v) => v === 0)).toBe(true);

  t = performance.now();
  while (history.redo(grid));
  const redoMs = performance.now() - t;
  expect(grid.cells).toEqual(final);

  return {
    singles,
    actions,
    singleUs: (singleMs * 1000) / singles,
    fillMsAvg: fillMs.reduce((a, b) => a + b, 0) / fillMs.length,
    fillMsP95: percentile(fillMs, 0.95),
    fillCellsAvg: fillCells / FILLS,
    undoMs,
    redoMs,
    undoRedoUsPerAction: ((undoMs + redoMs) * 1000) / (2 * actions),
    payloadBytes: history.bytes(),
    heldBytes,
  };
}

it('B2 history benchmark', async () => {
  const results = [];
  for (const size of SIZES) {
    for (const kind of Object.keys(KINDS)) {
      await runOnce(size, kind); // warm-up
      const runs: Awaited<ReturnType<typeof runOnce>>[] = [];
      for (let k = 0; k < RUNS; k++) runs.push(await runOnce(size, kind));
      const pick = (k: keyof (typeof runs)[0]) => spread(runs.map((r) => r[k]));
      const r = {
        size,
        kind,
        gridBytes: size * size * 2,
        singles: runs[0].singles,
        fills: FILLS,
        actions: runs[0].actions,
        fillCellsAvg: runs[0].fillCellsAvg,
        singleUs: pick('singleUs'),
        fillMsAvg: pick('fillMsAvg'),
        fillMsP95: pick('fillMsP95'),
        undoMs: pick('undoMs'),
        redoMs: pick('redoMs'),
        undoRedoUsPerAction: pick('undoRedoUsPerAction'),
        payloadBytes: runs[0].payloadBytes,
        heldBytes: pick('heldBytes'),
      };
      results.push(r);
      console.log(
        `${size}x${size} ${kind.padEnd(8)} single ${r.singleUs.median.toFixed(2)} us, fill ${r.fillMsAvg.median.toFixed(2)} ms ` +
          `(${Math.round(r.fillCellsAvg)} cells), undo ${r.undoMs.median.toFixed(1)} ms, redo ${r.redoMs.median.toFixed(1)} ms, ` +
          `held ${(r.heldBytes.median / 2 ** 20).toFixed(1)} MB`,
      );
    }
  }
  writeRaw('history', {
    bench: 'B2 history',
    date: new Date().toISOString(),
    quick: QUICK,
    machine: machineInfo(),
    config: { singleEdits: SINGLE_EDITS, fills: FILLS, fillCap: '50% of grid', runs: RUNS },
    results,
  });
});
