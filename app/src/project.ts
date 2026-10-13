import { createGrid, makePatternGrid } from './core/grid.ts';
import type { Grid } from './core/grid.ts';
import type { Backstitch, Editor } from './edit/editor.ts';
import { loadChart, saveChart } from './storage/library.ts';
import { makeThumbnail } from './storage/thumbnail.ts';
import { brandOf, indexMap, nearestThreads, paletteFor } from './threads/brands.ts';
import type { BrandId } from './threads/brands.ts';

/** The chart being edited. */
export interface Project {
  /** Its id in the library. Missing for charts that are not saved (the generated samples). */
  id?: string;
  name: string;
  grid: Grid;
  /** Brand of thread the chart is made with: every colour index refers to that brand's palette. */
  brand: BrandId;
  /** Fabric count: stitches per inch. Only affects the finished size shown to the user. */
  fabricCount: number;
  createdAt: number;
  /** Stitches of the other layers, as loaded from the library. The editor takes over from here. */
  quarters: Uint16Array | null;
  halves: Uint16Array | null;
  backstitches: Backstitch[];
  /** Set for the generated sample charts, so the menu can show which one is open. */
  sampleSize?: number;
}

/** Largest side a chart can have. The renderer and tools were measured up to this size. */
export const MAX_SIDE = 1000;
export const FABRIC_COUNTS = [11, 14, 16, 18, 20, 22, 25, 28, 32];
export const DEFAULT_FABRIC_COUNT = 14;

const blank = { quarters: null, halves: null, backstitches: [] };

/** A blank chart that belongs to the library. */
export function newProject(name: string, width: number, height: number, fabricCount: number, brand: BrandId): Project {
  return { id: crypto.randomUUID(), name, grid: createGrid(width, height), brand, fabricCount, createdAt: Date.now(), ...blank };
}

/** A chart for the library made from stitches that already exist (an imported image). */
export function projectFrom(name: string, grid: Grid, fabricCount: number, brand: BrandId): Project {
  return { id: crypto.randomUUID(), name, grid, brand, fabricCount, createdAt: Date.now(), ...blank };
}

/** A generated chart for trying the app. It is not saved. */
export function sampleProject(name: string, size: number, brand: BrandId): Project {
  const grid = makePatternGrid(size, size, paletteFor(brand).size);
  return { name, grid, brand, fabricCount: DEFAULT_FABRIC_COUNT, createdAt: Date.now(), sampleSize: size, ...blank };
}

/** Open a chart from the library, or null if it is no longer there. */
export async function openProject(id: string): Promise<Project | null> {
  const found = await loadChart(id);
  if (!found) return null;
  const { entry, data } = found;
  const brand = brandOf(entry.brand);
  // Saved indices are translated through the thread codes saved with them, so the chart keeps
  // its colours even if the brand's table has gained, lost or reordered entries since.
  let highest = 0;
  for (const values of [data.cells, data.quarters, data.halves]) for (const v of values ?? []) if (v > highest) highest = v;
  for (const l of data.backstitches) highest = Math.max(highest, l.color);
  const map = indexMap(brand, data.codes, highest);
  const fit = (v: number) => map[v];
  const fitAll = (values: Uint16Array | null) => {
    if (values) for (let i = 0; i < values.length; i++) values[i] = map[values[i]];
    return values;
  };
  return {
    id,
    name: entry.name,
    grid: { width: entry.width, height: entry.height, cells: fitAll(data.cells)! },
    brand,
    fabricCount: entry.fabricCount,
    createdAt: entry.createdAt,
    quarters: fitAll(data.quarters),
    halves: fitAll(data.halves),
    backstitches: data.backstitches.map((l) => ({ ...l, color: fit(l.color) })),
  };
}

/** Write a chart to the library as it is right now. `editor` holds the current state of its layers, if it is open. */
export async function saveProject(project: Project, editor?: Editor): Promise<void> {
  if (!project.id) return;
  const { grid } = project;
  const upper = editor ?? project;
  await saveChart(
    {
      id: project.id,
      name: project.name,
      width: grid.width,
      height: grid.height,
      brand: project.brand,
      fabricCount: project.fabricCount,
      createdAt: project.createdAt,
      updatedAt: Date.now(),
      thumbnail: await makeThumbnail(grid, paletteFor(project.brand), upper),
    },
    {
      id: project.id,
      codes: paletteFor(project.brand).entries.map((e) => e.code),
      cells: grid.cells,
      quarters: upper.quarters,
      halves: upper.halves,
      backstitches: [...upper.backstitches],
    },
  );
}

/**
 * The same chart made with another brand of thread: every colour becomes the closest one the
 * new brand has. Two colours can land on the same thread, so this cannot be reversed exactly.
 */
export function convertProject(project: Project, editor: Editor, brand: BrandId): Project {
  const map = nearestThreads(paletteFor(project.brand), paletteFor(brand));
  const convert = (values: Uint16Array | null) => values && values.map((v) => map[v]);
  return {
    ...project,
    brand,
    grid: { ...project.grid, cells: convert(project.grid.cells)! },
    quarters: convert(editor.quarters),
    halves: convert(editor.halves),
    backstitches: editor.backstitches.map((l) => ({ ...l, color: map[l.color] })),
  };
}

/**
 * The same chart on a canvas of another size. (dx, dy) is where the old top-left corner lands on
 * the new one, in cells: negative values crop. Stitches that end up outside are dropped, and so
 * are backstitch lines that do not fit whole.
 */
export function resizeProject(project: Project, editor: Editor, width: number, height: number, dx: number, dy: number): Project {
  const old = project.grid;
  const resized = (values: Uint16Array | null, per: number) => {
    if (!values) return null;
    const out = new Uint16Array(width * height * per);
    for (let y = Math.max(0, -dy); y < Math.min(old.height, height - dy); y++) {
      const from = Math.max(0, -dx);
      const to = Math.min(old.width, width - dx);
      if (to > from) out.set(values.subarray((y * old.width + from) * per, (y * old.width + to) * per), ((y + dy) * width + from + dx) * per);
    }
    return out;
  };
  const fits = (x: number, y: number) => x >= 0 && y >= 0 && x <= width * 2 && y <= height * 2;
  return {
    ...project,
    grid: { width, height, cells: resized(old.cells, 1)! },
    quarters: resized(editor.quarters, 4),
    halves: resized(editor.halves, 2),
    backstitches: editor.backstitches
      .map((l) => ({ ...l, x0: l.x0 + dx * 2, y0: l.y0 + dy * 2, x1: l.x1 + dx * 2, y1: l.y1 + dy * 2 }))
      .filter((l) => fits(l.x0, l.y0) && fits(l.x1, l.y1)),
  };
}

/** Finished size of `stitches` on fabric of this count, in centimetres. */
export function finishedCm(stitches: number, fabricCount: number): number {
  return (stitches / fabricCount) * 2.54;
}
