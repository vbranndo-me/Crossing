import type { Grid } from './grid.ts';

/**
 * One undoable action, as produced by the edit tools.
 * `runs` are [start, length] pairs; `prev`/`next` are either one value for the
 * whole action (pencil, flood fill, replace) or one value per changed cell.
 */
export interface Diff {
  runs: Uint32Array;
  count: number;
  prev: Uint16Array | number;
  next: Uint16Array | number;
}

export interface History {
  /** Record an action that has already been applied to the grid. */
  push(grid: Grid, diff: Diff): void;
  undo(grid: Grid): boolean;
  redo(grid: Grid): boolean;
  /** Payload bytes held by the history (excludes JS object headers). */
  bytes(): number;
  readonly length: number;
}

/** Apply the edit to the grid and return its diff. */
export function setCell(grid: Grid, index: number, value: number): Diff {
  const prev = grid.cells[index];
  grid.cells[index] = value;
  return { runs: Uint32Array.of(index, 1), count: 1, prev, next: value };
}

function write(cells: Uint16Array, diff: Diff, values: Uint16Array | number): void {
  const { runs } = diff;
  if (typeof values === 'number') {
    for (let r = 0; r < runs.length; r += 2) cells.fill(values, runs[r], runs[r] + runs[r + 1]);
  } else {
    for (let r = 0, k = 0; r < runs.length; r += 2) {
      cells.set(values.subarray(k, k + runs[r + 1]), runs[r]);
      k += runs[r + 1];
    }
  }
}

/** Diff history backed by typed arrays: runs + (uniform or per-cell) values. */
export class PackedHistory implements History {
  private actions: Diff[] = [];
  private cursor = 0;

  get length(): number {
    return this.actions.length;
  }

  push(_grid: Grid, diff: Diff): void {
    this.actions.length = this.cursor;
    this.actions.push(diff);
    this.cursor++;
  }

  undo(grid: Grid): boolean {
    if (this.cursor === 0) return false;
    const d = this.actions[--this.cursor];
    write(grid.cells, d, d.prev);
    return true;
  }

  redo(grid: Grid): boolean {
    if (this.cursor === this.actions.length) return false;
    const d = this.actions[this.cursor++];
    write(grid.cells, d, d.next);
    return true;
  }

  bytes(): number {
    let b = 0;
    for (const d of this.actions) {
      b += d.runs.byteLength;
      if (typeof d.prev !== 'number') b += d.prev.byteLength;
      if (typeof d.next !== 'number') b += d.next.byteLength;
    }
    return b;
  }
}

interface CellChange {
  index: number;
  prev: number;
  next: number;
}

/** Diff history exactly as written in the spec: `{ index, prev, next }[]` per action. */
export class ObjectHistory implements History {
  private actions: CellChange[][] = [];
  private cursor = 0;
  private cells = 0;

  get length(): number {
    return this.actions.length;
  }

  push(_grid: Grid, diff: Diff): void {
    const { runs, prev, next } = diff;
    const action: CellChange[] = new Array(diff.count);
    let k = 0;
    for (let r = 0; r < runs.length; r += 2) {
      for (let i = runs[r], end = i + runs[r + 1]; i < end; i++, k++) {
        action[k] = {
          index: i,
          prev: typeof prev === 'number' ? prev : prev[k],
          next: typeof next === 'number' ? next : next[k],
        };
      }
    }
    this.actions.length = this.cursor;
    this.actions.push(action);
    this.cursor++;
    this.cells += diff.count;
  }

  undo(grid: Grid): boolean {
    if (this.cursor === 0) return false;
    const action = this.actions[--this.cursor];
    const cells = grid.cells;
    for (let k = action.length - 1; k >= 0; k--) cells[action[k].index] = action[k].prev;
    return true;
  }

  redo(grid: Grid): boolean {
    if (this.cursor === this.actions.length) return false;
    const action = this.actions[this.cursor++];
    const cells = grid.cells;
    for (let k = 0; k < action.length; k++) cells[action[k].index] = action[k].next;
    return true;
  }

  /** Lower bound: 3 numbers per changed cell as 8-byte doubles; real heap use is measured. */
  bytes(): number {
    return this.cells * 24;
  }
}

/** Baseline: a full copy of the grid after every action. */
export class SnapshotHistory implements History {
  private snapshots: Uint16Array[];
  private cursor = 0;

  constructor(grid: Grid) {
    this.snapshots = [grid.cells.slice()];
  }

  get length(): number {
    return this.snapshots.length - 1;
  }

  push(grid: Grid, _diff: Diff): void {
    this.snapshots.length = this.cursor + 1;
    this.snapshots.push(grid.cells.slice());
    this.cursor++;
  }

  undo(grid: Grid): boolean {
    if (this.cursor === 0) return false;
    grid.cells.set(this.snapshots[--this.cursor]);
    return true;
  }

  redo(grid: Grid): boolean {
    if (this.cursor === this.snapshots.length - 1) return false;
    grid.cells.set(this.snapshots[++this.cursor]);
    return true;
  }

  bytes(): number {
    return this.snapshots.length * this.snapshots[0].byteLength;
  }
}
