import { describe, expect, it } from 'vitest';
import { createGrid } from './core/grid.ts';
import { createEditor } from './edit/editor.ts';
import { resizeProject } from './project.ts';
import type { Project } from './project.ts';

describe('resizeProject', () => {
  const make = () => {
    const grid = createGrid(4, 3);
    const editor = createEditor(grid, 5);
    editor.paintLine(0, 0, 3, 0, 1); // top row
    editor.paintLine(3, 2, 3, 2, 2); // bottom-right cell
    editor.paintHalves(1, 1, 1, 1, true, 3);
    editor.endStroke();
    editor.addBackstitch({ x0: 0, y0: 0, x1: 2, y1: 2, color: 4 });
    editor.addBackstitch({ x0: 6, y0: 4, x1: 8, y1: 6, color: 4 });
    const project: Project = { name: 'p', grid, brand: 'dmc', fabricCount: 14, createdAt: 0, quarters: null, halves: null, backstitches: [] };
    return { project, editor };
  };

  it('grows the canvas, moving every layer by the same offset', () => {
    const { project, editor } = make();
    const big = resizeProject(project, editor, 6, 5, 1, 2);
    expect([big.grid.width, big.grid.height, big.grid.cells.length]).toEqual([6, 5, 30]);
    expect([...big.grid.cells.slice(12, 18)]).toEqual([0, 1, 1, 1, 1, 0]); // the old top row, now row 2
    expect(big.grid.cells[4 * 6 + 4]).toBe(2);
    expect(big.halves![(3 * 6 + 2) * 2]).toBe(3);
    expect(big.backstitches[0]).toEqual({ x0: 2, y0: 4, x1: 4, y1: 6, color: 4 });
    expect(big.backstitches.length).toBe(2);
    // The chart it was made from is untouched.
    expect(project.grid.cells.length).toBe(12);
  });

  it('crops, dropping what is left outside', () => {
    const { project, editor } = make();
    const small = resizeProject(project, editor, 2, 2, -2, -1);
    expect([...small.grid.cells]).toEqual([0, 0, 0, 2]);
    expect(small.halves!.every((v) => v === 0)).toBe(true);
    // Only the line that fits whole is kept.
    expect(small.backstitches).toEqual([{ x0: 2, y0: 2, x1: 4, y1: 4, color: 4 }]);
  });
});
