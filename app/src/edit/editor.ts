import type { Grid } from '../core/grid.ts';
import { History } from './history.ts';

/** How a new selection combines with the current one. */
export type SelectMode = 'replace' | 'add' | 'subtract';

/** The chart is made of three fixed layers, one per kind of stitch. */
export type LayerId = 'full' | 'fractional' | 'backstitch';
export const LAYERS: LayerId[] = ['full', 'fractional', 'backstitch'];

/** A backstitch line. Coordinates are in half cells, so it can start at corners, edge middles and centres. */
export interface Backstitch {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number;
}

/** Positions of the four quarter stitches inside a cell's slot in `quarters`. */
export const QUARTER = { topLeft: 0, topRight: 1, bottomLeft: 2, bottomRight: 3 };
/** Positions of the two half stitches inside a cell's slot in `halves`: "/" then "\". */
export const HALF = { slash: 0, backslash: 1 };

/** A rectangle of full stitches taken from a chart. 0 = nothing there (it does not overwrite when pasted). */
export interface Clip {
  width: number;
  height: number;
  values: Uint16Array;
}

export type Transform = 'flipH' | 'flipV' | 'rotateCW' | 'rotateCCW';
export type Shape = 'rect' | 'ellipse';

export type BrushShape = 'round' | 'square';
export const MAX_BRUSH = 32;

/** A point in a stroke in progress, to go back to (see Editor.rewind). */
export interface StrokeMark {
  cells: number;
  slots: number;
}

/**
 * Cells a brush covers, as offsets from the cell under the pointer. Round brushes are the
 * pixel-art kind: 1 and 2 are squares, 3 is a plus, bigger ones have their corners cut.
 */
export function brushOffsets(size: number, shape: BrushShape): [number, number][] {
  const offsets: [number, number][] = [];
  const start = -Math.floor(size / 2);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const cx = i - (size - 1) / 2;
      const cy = j - (size - 1) / 2;
      if (shape === 'square' || size === 1 || cx * cx + cy * cy <= (size * size) / 4 - 0.3) offsets.push([start + i, start + j]);
    }
  }
  return offsets;
}

export interface Change {
  /** Cells whose full stitch changed. null = too many to list: treat the whole grid as changed. */
  cells: number[] | null;
  /** The selection changed. */
  selection: boolean;
  /** Cells whose half or quarter stitches changed. */
  fractions: number[];
  /** The backstitch lines changed. */
  backstitch: boolean;
}

/**
 * Everything that edits a chart: drawing, filling, selecting, undo and redo.
 * It owns the three layers, the per-colour counts and the selection, and tells subscribers
 * (the renderer, the panels) what changed.
 */
export interface Editor {
  readonly grid: Grid;
  /** Full stitches per palette index, kept up to date. */
  readonly counts: Uint32Array;
  /** Half stitches, quarter stitches and backstitch lines per palette index. */
  readonly extras: Uint32Array;
  /** Quarter stitches: 4 palette indices per cell (see QUARTER). null until the first one is drawn. */
  readonly quarters: Uint16Array | null;
  /** Half stitches: 2 palette indices per cell (see HALF). null until the first one is drawn. */
  readonly halves: Uint16Array | null;
  readonly backstitches: readonly Backstitch[];
  /** One byte per cell, 1 = selected; null when nothing is selected. While set, edits stay inside it. */
  readonly selection: Uint8Array | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;

  /** A locked layer ignores every drawing tool (undo and redo still apply). */
  setLocked(layer: LayerId, locked: boolean): void;
  isLocked(layer: LayerId): boolean;

  /** Size and shape of the pencil and the eraser. */
  setBrush(size: number, shape: BrushShape): void;
  /** Remember where the stroke in progress is, to `rewind` to later. */
  mark(): StrokeMark;
  /** Take back what the stroke in progress did since `mark` (used to redraw a straight line as it is dragged). */
  rewind(mark: StrokeMark): void;
  /** Pencil / eraser: set the full stitch of every cell on the line between two cells. */
  paintLine(x0: number, y0: number, x1: number, y1: number, value: number): void;
  /** Half stitches along a line of cells. `slash` picks "/" or "\"; value 0 erases both directions. */
  paintHalves(x0: number, y0: number, x1: number, y1: number, slash: boolean, value: number): void;
  /** Quarter stitches along a line. Coordinates are in half cells: each one names a corner of a cell. */
  paintQuarters(hx0: number, hy0: number, hx1: number, hy1: number, value: number): void;
  /**
   * Three-quarter stitches along a line of corners (half cells, as for quarters): the quarter in
   * that corner plus the half stitch across the other diagonal. Value 0 erases both.
   */
  paintThreeQuarters(hx0: number, hy0: number, hx1: number, hy1: number, value: number): void;
  /** Part of a stroke: a rectangle or an ellipse of full stitches between two cells (inclusive), outlined or filled. */
  paintShape(shape: Shape, x0: number, y0: number, x1: number, y1: number, value: number, filled: boolean): void;
  /**
   * Part of a stroke: the selected full stitches moved by (dx, dy) cells from where they were when
   * the stroke began, and the selection with them. What leaves the chart is lost.
   */
  dragSelection(dx: number, dy: number): void;
  /** Remove the backstitch lines passing within `radius` cells of a point (in cells). */
  eraseBackstitchNear(x: number, y: number, radius: number): void;
  /** The stroke (any of the four above) is finished: it becomes one undo step. */
  endStroke(): void;
  addBackstitch(line: Backstitch): void;
  /** A French knot at a point (in half cells). It lives with the backstitch lines, as a line of no length. */
  addKnot(x: number, y: number, color: number): void;
  /** The selected full stitches, as the smallest rectangle that holds them. null with nothing selected. */
  copySelection(): Clip | null;
  /** Put a clip's stitches on the chart with its top-left corner at a cell, and select them. */
  paste(clip: Clip, x: number, y: number): void;
  /** Mirror or turn the selected full stitches (the whole chart with nothing selected) inside their own rectangle. */
  transformSelection(kind: Transform): void;
  /** Every stitch of one colour, on all layers, becomes another colour (inside the selection, if there is one). */
  replaceColor(from: number, to: number): void;
  /** Bucket: recolour the connected area of equal full stitches around `index`. */
  fill(index: number, value: number): void;
  /**
   * Gradient bucket: recolour the connected area around `index` with `ramp` (palette indices, first
   * to last) running from (x0, y0) to (x1, y1), in cells. With both points equal, it runs across
   * the area from left to right.
   */
  gradientFill(index: number, ramp: Uint16Array, x0: number, y0: number, x1: number, y1: number): void;
  /** Magic wand: select the connected area of equal full stitches around `index`. */
  wand(index: number, mode: SelectMode): void;
  /** Rectangle select, corners inclusive. `base` is the selection the drag started from. */
  selectRect(x0: number, y0: number, x1: number, y1: number, mode: SelectMode, base: Uint8Array | null): void;
  selectAll(): void;
  deselect(): void;
  /** Empty the full stitch of every selected cell. */
  eraseSelection(): void;
  /** Eyedropper: colour of the topmost stitch at a point (in cells) among the given layers, or 0. */
  colorAt(x: number, y: number, layers: Record<LayerId, boolean>): number;
  undo(): void;
  redo(): void;
  subscribe(listener: (change: Change) => void): () => void;
}

/** Above this many changed cells a change is reported as "everything". */
const LIST_LIMIT = 4096;
/** How close to a backstitch line (in cells) a point has to be to count as on it. */
const LINE_REACH = 0.3;
/** How far from a diagonal (x1.41, in cells) a point can be and still be on a half / quarter stitch. */
const STRAND_REACH = 0.16;

/** [start, length] runs of cells plus what they were and what they became (one value, or one per cell). */
interface Diff {
  runs: Uint32Array;
  count: number;
  prev: Uint16Array | number;
  next: Uint16Array | number;
}

/** Cells on the straight line between two cells (Bresenham); either end may be outside the grid. */
function line(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    visit(x, y);
    if (x === x1 && y === y1) return;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

/** Distance from a point to a segment, all in the same units. */
function distance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Stitches of the other layers to start from (a chart opened from the library). */
export interface InitialLayers {
  quarters: Uint16Array | null;
  halves: Uint16Array | null;
  backstitches: Backstitch[];
}

export function createEditor(grid: Grid, paletteSize: number, initial?: InitialLayers): Editor {
  const { width, height, cells } = grid;
  const total = cells.length;
  const counts = new Uint32Array(paletteSize + 1);
  for (let i = 0; i < total; i++) counts[cells[i]]++;
  const extras = new Uint32Array(paletteSize + 1);

  const history = new History();
  const listeners = new Set<(change: Change) => void>();
  const locked: Record<LayerId, boolean> = { full: false, fractional: false, backstitch: false };
  let selection: Uint8Array | null = null;
  let quarters: Uint16Array | null = initial?.quarters ?? null;
  let halves: Uint16Array | null = initial?.halves ?? null;
  const backstitches: Backstitch[] = [...(initial?.backstitches ?? [])];
  for (const array of [quarters, halves]) for (const value of array ?? []) if (value !== 0) extras[value]++;
  for (const l of backstitches) extras[l.color]++;

  let brush: [number, number][] = [[0, 0]];

  const emit = (change: Partial<Change>) => {
    const full: Change = { cells: [], selection: false, fractions: [], backstitch: false, ...change };
    for (const listener of listeners) listener(full);
  };

  const editable = (i: number) => selection === null || selection[i] === 1;

  // ---- full stitches ----

  /** Stroke in progress: cells changed so far and what they were. */
  let strokeCells: number[] = [];
  let strokePrev: number[] = [];
  let strokeValue = 0;

  /** Write values over runs of cells, keeping the counts right. Returns what to report as changed. */
  const write = (diff: Diff, values: Uint16Array | number): number[] | null => {
    const { runs } = diff;
    const changed: number[] | null = diff.count <= LIST_LIMIT ? [] : null;
    for (let r = 0, k = 0; r < runs.length; r += 2) {
      for (let i = runs[r], end = i + runs[r + 1]; i < end; i++, k++) {
        const value = typeof values === 'number' ? values : values[k];
        counts[cells[i]]--;
        counts[value]++;
        cells[i] = value;
        changed?.push(i);
      }
    }
    return changed;
  };

  /** Part of a stroke: set one cell's full stitch, whatever the selection says, and remember what it was. */
  const put = (i: number, value: number, changed: number[]) => {
    const previous = cells[i];
    if (previous === value) return;
    cells[i] = value;
    counts[previous]--;
    counts[value]++;
    strokeCells.push(i);
    strokePrev.push(previous);
    changed.push(i);
  };

  /** The diff of the stroke in progress: each cell once, from what it was before the stroke to what it is now. */
  const strokeDiff = (): Diff | null => {
    const before = new Map<number, number>();
    for (let k = 0; k < strokeCells.length; k++) if (!before.has(strokeCells[k])) before.set(strokeCells[k], strokePrev[k]);
    const indices = [...before.keys()].filter((i) => before.get(i) !== cells[i]).sort((a, b) => a - b);
    if (indices.length === 0) return null;
    const runs: number[] = [];
    const prev = new Uint16Array(indices.length);
    const next = new Uint16Array(indices.length);
    indices.forEach((i, at) => {
      prev[at] = before.get(i)!;
      next[at] = cells[i];
      if (runs.length > 0 && runs[runs.length - 2] + runs[runs.length - 1] === i) runs[runs.length - 1]++;
      else runs.push(i, 1);
    });
    const one = (values: Uint16Array) => (values.every((v) => v === values[0]) ? values[0] : values);
    return { runs: Uint32Array.from(runs), count: indices.length, prev: one(prev), next: one(next) };
  };

  /** Record a change to full stitches that has already been applied. */
  const pushDiff = (diff: Diff) => {
    const size = (v: Uint16Array | number) => (typeof v === 'number' ? 0 : v.byteLength);
    const bytes = diff.runs.byteLength + size(diff.prev) + size(diff.next);
    history.push({ bytes, undo: () => emit({ cells: write(diff, diff.prev) }), redo: () => emit({ cells: write(diff, diff.next) }) });
  };

  /** Diff for a set of cells that all became `next`, given what each one was. `ascending`: already in index order. */
  const diffOf = (indices: number[], previous: number[], next: number, ascending = false): Diff => {
    const order = indices.map((_, k) => k);
    if (!ascending) order.sort((a, b) => indices[a] - indices[b]);
    const runs: number[] = [];
    const prev = new Uint16Array(order.length);
    order.forEach((k, at) => {
      const i = indices[k];
      prev[at] = previous[k];
      if (runs.length > 0 && runs[runs.length - 2] + runs[runs.length - 1] === i) runs[runs.length - 1]++;
      else runs.push(i, 1);
    });
    return { runs: Uint32Array.from(runs), count: order.length, prev: prev.every((v) => v === prev[0]) ? prev[0] : prev, next };
  };

  /**
   * Connected area (4 neighbours) of cells equal to the one at `start`, as [start, length] runs.
   * With `inside`, the area also stops at the edge of the selection.
   */
  const region = (start: number, inside: boolean): Uint32Array => {
    const target = cells[start];
    const seen = new Uint8Array(total);
    const match = (i: number) => seen[i] === 0 && cells[i] === target && (!inside || editable(i));
    const stack = [start];
    const runs: number[] = [];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (!match(i)) continue;
      const row = i - (i % width);
      let l = i;
      let r = i;
      while (l > row && match(l - 1)) l--;
      while (r < row + width - 1 && match(r + 1)) r++;
      seen.fill(1, l, r + 1);
      runs.push(l, r - l + 1);
      for (const dy of [-width, width]) {
        if (l + dy < 0 || l + dy >= total) continue;
        let open = false;
        for (let j = l + dy; j <= r + dy; j++) {
          if (match(j)) {
            if (!open) stack.push(j);
            open = true;
          } else {
            open = false;
          }
        }
      }
    }
    return Uint32Array.from(runs);
  };

  // ---- half and quarter stitches ----

  /** Stroke in progress on the fractional layer: which slots changed and what they held. */
  let strokeSlots: { quarter: boolean; slot: number; prev: number; next: number }[] = [];

  /** Set one half / quarter slot. Returns whether it changed. */
  const setSlot = (quarter: boolean, slot: number, value: number): boolean => {
    quarters ??= new Uint16Array(total * 4);
    halves ??= new Uint16Array(total * 2);
    const array = quarter ? quarters : halves;
    const prev = array[slot];
    if (prev === value) return false;
    if (prev !== 0) extras[prev]--;
    if (value !== 0) extras[value]++;
    array[slot] = value;
    return true;
  };

  /** Part of a stroke: set a slot and remember what it was. */
  const strokeSlot = (quarter: boolean, slot: number, value: number, changed: Set<number>) => {
    const prev = (quarter ? quarters : halves)?.[slot] ?? 0;
    if (!setSlot(quarter, slot, value)) return;
    strokeSlots.push({ quarter, slot, prev, next: value });
    changed.add(Math.floor(slot / (quarter ? 4 : 2)));
  };

  // ---- backstitch ----

  /** Lines removed by the eraser stroke in progress, with where each one was in the list. */
  let strokeRemoved: { at: number; line: Backstitch }[] = [];

  // ---- selection ----

  const setSelection = (mask: Uint8Array | null) => {
    selection = mask !== null && mask.includes(1) ? mask : null;
    emit({ selection: true });
  };

  /** The selection being moved by the stroke in progress: where it started and what it held. */
  let lift: { indices: number[]; values: number[]; mark: StrokeMark } | null = null;

  /** Smallest rectangle around the selected cells (around the whole chart with nothing selected). */
  const bounds = (mask: Uint8Array | null) => {
    if (mask === null) return { x: 0, y: 0, w: width, h: height };
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < total; i++) {
      if (mask[i] === 0) continue;
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  const rewindTo = (mark: StrokeMark) => {
    const changed: number[] = [];
    while (strokeCells.length > mark.cells) {
      const i = strokeCells.pop()!;
      const previous = strokePrev.pop()!;
      counts[cells[i]]--;
      counts[previous]++;
      cells[i] = previous;
      changed.push(i);
    }
    const fractions = new Set<number>();
    while (strokeSlots.length > mark.slots) {
      const s = strokeSlots.pop()!;
      setSlot(s.quarter, s.slot, s.prev);
      fractions.add(Math.floor(s.slot / (s.quarter ? 4 : 2)));
    }
    if (changed.length > 0 || fractions.size > 0) emit({ cells: changed.length > LIST_LIMIT ? null : changed, fractions: [...fractions] });
  };

  /** The stroke in progress becomes undo steps (one per layer it touched). */
  const commit = () => {
    lift = null;
    const diff = strokeDiff();
    if (diff) pushDiff(diff);
    strokeCells = [];
    strokePrev = [];

    if (strokeSlots.length > 0) {
      const slots = strokeSlots;
      const apply = (which: 'prev' | 'next') => {
        const changed = new Set<number>();
        for (const s of slots) if (setSlot(s.quarter, s.slot, s[which])) changed.add(Math.floor(s.slot / (s.quarter ? 4 : 2)));
        emit({ fractions: [...changed] });
      };
      history.push({ bytes: slots.length * 32, undo: () => apply('prev'), redo: () => apply('next') });
      strokeSlots = [];
    }

    if (strokeRemoved.length > 0) {
      const removed = strokeRemoved;
      history.push({
        bytes: removed.length * 64,
        // Put the lines back in reverse order, so each one lands where it was.
        undo: () => {
          for (let k = removed.length - 1; k >= 0; k--) {
            backstitches.splice(removed[k].at, 0, removed[k].line);
            extras[removed[k].line.color]++;
          }
          emit({ backstitch: true });
        },
        redo: () => {
          for (const r of removed) {
            backstitches.splice(r.at, 1);
            extras[r.line.color]--;
          }
          emit({ backstitch: true });
        },
      });
      strokeRemoved = [];
    }
  };

  /**
   * Move the stitches of `indices` (with their `values`) to where `to` sends each one (a cell
   * index, or -1 for "off the chart"), as part of the stroke; the selection becomes the cells they land on.
   */
  const relocate = (indices: number[], values: number[], to: (i: number) => number) => {
    const changed: number[] = [];
    const moved = new Uint8Array(total);
    for (let k = 0; k < indices.length; k++) if (values[k] !== 0) put(indices[k], 0, changed);
    for (let k = 0; k < indices.length; k++) {
      const j = to(indices[k]);
      if (j < 0) continue;
      moved[j] = 1;
      // Empty cells travel with the selection but do not erase what they land on.
      if (values[k] !== 0) put(j, values[k], changed);
    }
    selection = moved.includes(1) ? moved : null;
    emit({ cells: changed.length > LIST_LIMIT ? null : changed, selection: true });
  };

  /** The selected cells (all of them with no selection) and their full stitches. */
  const selected = () => {
    const indices: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < total; i++) {
      if (selection !== null && selection[i] === 0) continue;
      indices.push(i);
      values.push(cells[i]);
    }
    return { indices, values };
  };

  const addLine = (added: Backstitch) => {
    const add = () => {
      backstitches.push(added);
      extras[added.color]++;
      emit({ backstitch: true });
    };
    add();
    history.push({
      bytes: 64,
      undo: () => {
        backstitches.splice(backstitches.lastIndexOf(added), 1);
        extras[added.color]--;
        emit({ backstitch: true });
      },
      redo: add,
    });
  };

  /** A copy of `base` (or an empty mask) to add to or subtract from. */
  const maskFor = (mode: SelectMode, base: Uint8Array | null) => (mode === 'replace' || base === null ? new Uint8Array(total) : base.slice());

  return {
    grid,
    counts,
    extras,
    backstitches,
    get quarters() {
      return quarters;
    },
    get halves() {
      return halves;
    },
    get selection() {
      return selection;
    },
    get canUndo() {
      return history.canUndo;
    },
    get canRedo() {
      return history.canRedo;
    },

    setBrush(size, shape) {
      brush = brushOffsets(Math.max(1, Math.min(MAX_BRUSH, Math.round(size))), shape);
    },

    mark: () => ({ cells: strokeCells.length, slots: strokeSlots.length }),

    rewind: rewindTo,

    setLocked(layer, value) {
      locked[layer] = value;
    },
    isLocked: (layer) => locked[layer],

    paintLine(x0, y0, x1, y1, value) {
      if (locked.full) return;
      strokeValue = value;
      const changed: number[] = [];
      line(x0, y0, x1, y1, (px, py) => {
        for (const [ox, oy] of brush) {
          const x = px + ox;
          const y = py + oy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = y * width + x;
          const previous = cells[i];
          if (previous === value || !editable(i)) continue;
          cells[i] = value;
          counts[previous]--;
          counts[value]++;
          strokeCells.push(i);
          strokePrev.push(previous);
          changed.push(i);
        }
      });
      if (changed.length > 0) emit({ cells: changed.length > LIST_LIMIT ? null : changed });
    },

    paintHalves(x0, y0, x1, y1, slash, value) {
      if (locked.fractional) return;
      const changed = new Set<number>();
      line(x0, y0, x1, y1, (px, py) => {
        for (const [ox, oy] of brush) {
          const x = px + ox;
          const y = py + oy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = y * width + x;
          if (!editable(i)) continue;
          if (value === 0 || slash) strokeSlot(false, i * 2 + HALF.slash, value, changed);
          if (value === 0 || !slash) strokeSlot(false, i * 2 + HALF.backslash, value, changed);
        }
      });
      if (changed.size > 0) emit({ fractions: [...changed] });
    },

    paintQuarters(hx0, hy0, hx1, hy1, value) {
      if (locked.fractional) return;
      const changed = new Set<number>();
      line(hx0, hy0, hx1, hy1, (px, py) => {
        // The brush is measured in corners here: size 2 covers one whole cell.
        for (const [ox, oy] of brush) {
          const hx = px + ox;
          const hy = py + oy;
          const x = hx >> 1;
          const y = hy >> 1;
          if (hx < 0 || hy < 0 || x >= width || y >= height) continue;
          const i = y * width + x;
          if (editable(i)) strokeSlot(true, i * 4 + (hx & 1) + (hy & 1) * 2, value, changed);
        }
      });
      if (changed.size > 0) emit({ fractions: [...changed] });
    },

    eraseBackstitchNear(x, y, radius) {
      if (locked.backstitch) return;
      let removed = false;
      for (let k = backstitches.length - 1; k >= 0; k--) {
        const l = backstitches[k];
        if (distance(x, y, l.x0 / 2, l.y0 / 2, l.x1 / 2, l.y1 / 2) > radius) continue;
        backstitches.splice(k, 1);
        extras[l.color]--;
        strokeRemoved.push({ at: k, line: l });
        removed = true;
      }
      if (removed) emit({ backstitch: true });
    },

    endStroke: commit,

    addBackstitch(added) {
      if (locked.backstitch || (added.x0 === added.x1 && added.y0 === added.y1)) return;
      addLine(added);
    },

    addKnot(x, y, color) {
      if (locked.backstitch || x < 0 || y < 0 || x > width * 2 || y > height * 2) return;
      // One knot per point: a second one there would only hide the first.
      if (backstitches.some((l) => l.x0 === x && l.y0 === y && l.x1 === x && l.y1 === y && l.color === color)) return;
      addLine({ x0: x, y0: y, x1: x, y1: y, color });
    },

    paintThreeQuarters(hx0, hy0, hx1, hy1, value) {
      if (locked.fractional) return;
      const changed = new Set<number>();
      line(hx0, hy0, hx1, hy1, (hx, hy) => {
        const x = hx >> 1;
        const y = hy >> 1;
        if (hx < 0 || hy < 0 || x >= width || y >= height) return;
        const i = y * width + x;
        if (!editable(i)) return;
        const corner = (hx & 1) + (hy & 1) * 2;
        strokeSlot(true, i * 4 + corner, value, changed);
        // The quarter runs along one diagonal; the half that completes it is the other one.
        const onBackslash = corner === QUARTER.topLeft || corner === QUARTER.bottomRight;
        strokeSlot(false, i * 2 + (onBackslash ? HALF.slash : HALF.backslash), value, changed);
      });
      if (changed.size > 0) emit({ fractions: [...changed] });
    },

    paintShape(shape, x0, y0, x1, y1, value, filled) {
      if (locked.full) return;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const w = Math.abs(x1 - x0) + 1;
      const h = Math.abs(y1 - y0) + 1;
      // Whether a cell of the bounding box belongs to the shape.
      const inside = (u: number, v: number) => {
        if (u < 0 || v < 0 || u >= w || v >= h) return false;
        if (shape === 'rect') return true;
        const dx = (u + 0.5 - w / 2) / (w / 2);
        const dy = (v + 0.5 - h / 2) / (h / 2);
        return dx * dx + dy * dy <= 1;
      };
      const changed: number[] = [];
      for (let v = 0; v < h; v++) {
        for (let u = 0; u < w; u++) {
          if (!inside(u, v)) continue;
          // The outline: cells of the shape with a neighbour that is not.
          if (!filled && inside(u - 1, v) && inside(u + 1, v) && inside(u, v - 1) && inside(u, v + 1)) continue;
          const x = left + u;
          const y = top + v;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = y * width + x;
          if (editable(i)) put(i, value, changed);
        }
      }
      strokeValue = value;
      if (changed.length > 0) emit({ cells: changed.length > LIST_LIMIT ? null : changed });
    },

    dragSelection(dx, dy) {
      if (locked.full) return;
      if (!lift) {
        if (selection === null) return;
        lift = { ...selected(), mark: { cells: strokeCells.length, slots: strokeSlots.length } };
      }
      rewindTo(lift.mark);
      relocate(lift.indices, lift.values, (i) => {
        const x = (i % width) + dx;
        const y = Math.floor(i / width) + dy;
        return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
      });
    },

    copySelection() {
      if (selection === null) return null;
      const box = bounds(selection);
      const values = new Uint16Array(box.w * box.h);
      for (let v = 0; v < box.h; v++) {
        for (let u = 0; u < box.w; u++) {
          const i = (box.y + v) * width + box.x + u;
          if (selection[i] === 1) values[v * box.w + u] = cells[i];
        }
      }
      return { width: box.w, height: box.h, values };
    },

    paste(clip, x, y) {
      if (locked.full) return;
      const changed: number[] = [];
      const mask = new Uint8Array(total);
      for (let v = 0; v < clip.height; v++) {
        for (let u = 0; u < clip.width; u++) {
          const value = clip.values[v * clip.width + u];
          const px = x + u;
          const py = y + v;
          if (value === 0 || px < 0 || py < 0 || px >= width || py >= height) continue;
          mask[py * width + px] = 1;
          put(py * width + px, value, changed);
        }
      }
      selection = mask.includes(1) ? mask : null;
      emit({ cells: changed.length > LIST_LIMIT ? null : changed, selection: true });
      commit();
    },

    transformSelection(kind) {
      if (locked.full) return;
      const box = bounds(selection);
      if (box.w <= 0) return;
      const turns = kind === 'rotateCW' || kind === 'rotateCCW';
      // A turned rectangle swaps its sides; it stays centred where it was.
      const left = turns ? box.x + Math.trunc((box.w - box.h) / 2) : box.x;
      const top = turns ? box.y + Math.trunc((box.h - box.w) / 2) : box.y;
      const { indices, values } = selected();
      relocate(indices, values, (i) => {
        const u = (i % width) - box.x;
        const v = Math.floor(i / width) - box.y;
        const [nu, nv] = kind === 'flipH' ? [box.w - 1 - u, v] : kind === 'flipV' ? [u, box.h - 1 - v] : kind === 'rotateCW' ? [box.h - 1 - v, u] : [v, box.w - 1 - u];
        const x = left + nu;
        const y = top + nv;
        return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
      });
      commit();
    },

    replaceColor(from, to) {
      if (from === to || from === 0 || to === 0) return;
      history.group(() => {
        if (!locked.full) {
          const changed: number[] = [];
          for (let i = 0; i < total; i++) if (cells[i] === from && editable(i)) put(i, to, changed);
          if (changed.length > 0) emit({ cells: changed.length > LIST_LIMIT ? null : changed });
        }
        if (!locked.fractional) {
          const changed = new Set<number>();
          for (const quarter of [true, false]) {
            const array = quarter ? quarters : halves;
            const per = quarter ? 4 : 2;
            for (let slot = 0; array && slot < array.length; slot++) {
              if (array[slot] === from && editable(Math.floor(slot / per))) strokeSlot(quarter, slot, to, changed);
            }
          }
          if (changed.size > 0) emit({ fractions: [...changed] });
        }
        commit();
        // Backstitch lines and knots are recoloured whole, when the cell they start in is selected.
        const lines = locked.backstitch
          ? []
          : backstitches.filter((l) => l.color === from && editable(Math.min(height - 1, l.y0 >> 1) * width + Math.min(width - 1, l.x0 >> 1)));
        if (lines.length > 0) {
          const paint = (color: number) => {
            for (const l of lines) {
              extras[l.color]--;
              l.color = color;
              extras[color]++;
            }
            emit({ backstitch: true });
          };
          paint(to);
          history.push({ bytes: lines.length * 8, undo: () => paint(from), redo: () => paint(to) });
        }
      });
    },

    fill(index, value) {
      const target = cells[index];
      if (locked.full || target === value || !editable(index)) return;
      const runs = region(index, true);
      let count = 0;
      for (let r = 1; r < runs.length; r += 2) count += runs[r];
      const diff: Diff = { runs, count, prev: target, next: value };
      pushDiff(diff);
      emit({ cells: write(diff, value) });
    },

    gradientFill(index, ramp, x0, y0, x1, y1) {
      if (locked.full || !editable(index) || ramp.length === 0) return;
      const target = cells[index];
      const found = region(index, true);
      // Scanline order is not index order: sort the runs so values and cells line up when replayed.
      const pairs: [number, number][] = [];
      for (let r = 0; r < found.length; r += 2) pairs.push([found[r], found[r + 1]]);
      pairs.sort((a, b) => a[0] - b[0]);
      const runs = Uint32Array.from(pairs.flat());
      let count = 0;
      let left = width;
      let right = 0;
      for (const [start, length] of pairs) {
        count += length;
        left = Math.min(left, start % width);
        right = Math.max(right, (start % width) + length);
      }
      if (x0 === x1 && y0 === y1) {
        x0 = left;
        x1 = right;
        y1 = y0;
      }
      const dx = x1 - x0;
      const dy = y1 - y0;
      const length = dx * dx + dy * dy || 1;
      const next = new Uint16Array(count);
      let k = 0;
      for (const [start, run] of pairs) {
        for (let i = start; i < start + run; i++, k++) {
          // Position of the cell's centre along the line, 0 at the start and 1 at the end.
          const t = (((i % width) + 0.5 - x0) * dx + (Math.floor(i / width) + 0.5 - y0) * dy) / length;
          next[k] = ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(t * ramp.length)))];
        }
      }
      const diff: Diff = { runs, count, prev: target, next };
      pushDiff(diff);
      emit({ cells: write(diff, next) });
    },

    wand(index, mode) {
      const mask = maskFor(mode, selection);
      const runs = region(index, false);
      for (let r = 0; r < runs.length; r += 2) mask.fill(mode === 'subtract' ? 0 : 1, runs[r], runs[r] + runs[r + 1]);
      setSelection(mask);
    },

    selectRect(x0, y0, x1, y1, mode, base) {
      const mask = maskFor(mode, base);
      const left = Math.max(0, Math.min(x0, x1));
      const right = Math.min(width - 1, Math.max(x0, x1));
      const top = Math.max(0, Math.min(y0, y1));
      const bottom = Math.min(height - 1, Math.max(y0, y1));
      for (let y = top; y <= bottom; y++) mask.fill(mode === 'subtract' ? 0 : 1, y * width + left, y * width + right + 1);
      setSelection(mask);
    },

    selectAll() {
      setSelection(new Uint8Array(total).fill(1));
    },

    deselect() {
      if (selection !== null) setSelection(null);
    },

    eraseSelection() {
      if (selection === null || locked.full) return;
      const indices: number[] = [];
      const previous: number[] = [];
      for (let i = 0; i < total; i++) {
        if (selection[i] === 1 && cells[i] !== 0) {
          indices.push(i);
          previous.push(cells[i]);
        }
      }
      if (indices.length === 0) return;
      const diff = diffOf(indices, previous, 0, true);
      pushDiff(diff);
      emit({ cells: write(diff, 0) });
    },

    colorAt(x, y, layers) {
      if (layers.backstitch) {
        for (let k = backstitches.length - 1; k >= 0; k--) {
          const l = backstitches[k];
          if (distance(x, y, l.x0 / 2, l.y0 / 2, l.x1 / 2, l.y1 / 2) <= LINE_REACH) return l.color;
        }
      }
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return 0;
      const i = cy * width + cx;
      if (layers.fractional && halves && quarters) {
        const fx = x - cx;
        const fy = y - cy;
        // Same shapes as on screen: strands along the diagonals, a quarter one only in its corner.
        const onSlash = Math.abs(fx + fy - 1) < STRAND_REACH;
        const onBackslash = Math.abs(fx - fy) < STRAND_REACH;
        if (halves[i * 2 + HALF.backslash] !== 0 && onBackslash) return halves[i * 2 + HALF.backslash];
        if (halves[i * 2 + HALF.slash] !== 0 && onSlash) return halves[i * 2 + HALF.slash];
        const quarter = quarters[i * 4 + (fx < 0.5 ? 0 : 1) + (fy < 0.5 ? 0 : 2)];
        if (quarter !== 0 && (fx < 0.5 === fy < 0.5 ? onBackslash : onSlash)) return quarter;
      }
      return layers.full ? cells[i] : 0;
    },

    undo() {
      history.undo();
    },

    redo() {
      history.redo();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
