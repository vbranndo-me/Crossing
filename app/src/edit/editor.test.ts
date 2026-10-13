import { describe, expect, it } from 'vitest';
import { createGrid } from '../core/grid.ts';
import { makePalette } from '../core/palette.ts';
import { brushOffsets, createEditor } from './editor.ts';
import { gradientRamp } from './gradient.ts';
import type { Change } from './editor.ts';

const setup = (width = 10, height = 8) => {
  const grid = createGrid(width, height);
  const editor = createEditor(grid, 5);
  const changes: Change[] = [];
  editor.subscribe((c) => changes.push(c));
  const at = (x: number, y: number) => grid.cells[y * width + x];
  const countsMatch = () => {
    const real = new Uint32Array(6);
    for (const v of grid.cells) real[v]++;
    return real.every((n, i) => n === editor.counts[i]);
  };
  return { grid, editor, changes, at, countsMatch };
};

describe('editor', () => {
  it('draws lines without gaps and undoes a stroke as one step', () => {
    const { editor, grid, at, countsMatch } = setup();
    editor.paintLine(1, 1, 6, 1, 2);
    editor.paintLine(6, 1, 6, 5, 2);
    editor.endStroke();
    expect(editor.counts[2]).toBe(10);
    expect(at(4, 1)).toBe(2);
    expect(at(6, 4)).toBe(2);
    editor.undo();
    expect(grid.cells.every((v) => v === 0)).toBe(true);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.counts[2]).toBe(10);
    expect(countsMatch()).toBe(true);
  });

  it('ignores the parts of a line that are outside the grid', () => {
    const { editor, countsMatch } = setup();
    editor.paintLine(-5, 2, 3, 2, 1);
    editor.endStroke();
    expect(editor.counts[1]).toBe(4);
    expect(countsMatch()).toBe(true);
  });

  it('undo restores what each cell was, not just "empty"', () => {
    const { editor, at } = setup();
    editor.paintLine(0, 0, 4, 0, 1);
    editor.endStroke();
    editor.paintLine(2, 0, 7, 0, 3);
    editor.endStroke();
    editor.undo();
    expect([at(1, 0), at(2, 0), at(4, 0), at(5, 0)]).toEqual([1, 1, 1, 0]);
  });

  it('the eraser empties cells', () => {
    const { editor, at } = setup();
    editor.paintLine(0, 0, 4, 0, 1);
    editor.endStroke();
    editor.paintLine(1, 0, 2, 0, 0);
    editor.endStroke();
    expect([at(0, 0), at(1, 0), at(2, 0), at(3, 0)]).toEqual([1, 0, 0, 1]);
    expect(editor.counts[1]).toBe(3);
  });

  it('fills only the connected area', () => {
    const { editor, at, countsMatch } = setup();
    // A wall at x = 4 splits the grid in two.
    editor.paintLine(4, 0, 4, 7, 1);
    editor.endStroke();
    editor.fill(0, 2);
    expect(editor.counts[2]).toBe(4 * 8);
    expect(at(5, 3)).toBe(0);
    editor.undo();
    expect(editor.counts[2]).toBe(0);
    expect(editor.counts[1]).toBe(8);
    expect(countsMatch()).toBe(true);
  });

  it('the wand selects the connected area; shift adds, alt subtracts', () => {
    const { editor } = setup();
    editor.paintLine(4, 0, 4, 7, 1);
    editor.endStroke();
    const selected = () => editor.selection?.reduce((a, v) => a + v, 0) ?? 0;
    editor.wand(0, 'replace');
    expect(selected()).toBe(32);
    editor.wand(9, 'add');
    expect(selected()).toBe(32 + 40);
    editor.wand(0, 'subtract');
    expect(selected()).toBe(40);
    editor.wand(9, 'subtract');
    expect(editor.selection).toBeNull();
  });

  it('edits stay inside the selection', () => {
    const { editor, at } = setup();
    editor.selectRect(2, 2, 4, 4, 'replace', null);
    editor.paintLine(0, 3, 9, 3, 1);
    editor.endStroke();
    expect(editor.counts[1]).toBe(3);
    editor.fill(2 * 10 + 2, 2); // inside: the empty row above the line, and no further than the selection
    expect(editor.counts[2]).toBe(3);
    expect(at(1, 2)).toBe(0);
    editor.fill(0, 4); // outside the selection: nothing
    expect(editor.counts[4]).toBe(0);
  });

  it('erases the selection as one undoable step', () => {
    const { editor, countsMatch } = setup();
    editor.paintLine(0, 0, 9, 0, 1);
    editor.endStroke();
    editor.selectRect(3, 0, 5, 7, 'replace', null);
    editor.eraseSelection();
    expect(editor.counts[1]).toBe(7);
    editor.undo();
    expect(editor.counts[1]).toBe(10);
    expect(countsMatch()).toBe(true);
  });

  it('a new action discards what had been undone', () => {
    const { editor } = setup();
    editor.paintLine(0, 0, 2, 0, 1);
    editor.endStroke();
    editor.undo();
    expect(editor.canRedo).toBe(true);
    editor.paintLine(0, 1, 2, 1, 2);
    editor.endStroke();
    expect(editor.canRedo).toBe(false);
  });

  it('reports small changes cell by cell and big ones as "everything"', () => {
    const { editor, changes } = setup(100, 100);
    editor.paintLine(0, 0, 3, 0, 1);
    expect(changes.at(-1)).toMatchObject({ cells: [0, 1, 2, 3], selection: false });
    editor.endStroke();
    editor.fill(500, 2);
    expect(changes.at(-1)!.cells).toBeNull();
    editor.selectAll();
    expect(changes.at(-1)).toMatchObject({ cells: [], selection: true });
  });

  it('half stitches: one direction per stroke, both can share a cell, the eraser clears both', () => {
    const { editor, changes } = setup();
    expect(editor.halves).toBeNull();
    editor.paintHalves(1, 1, 3, 1, true, 2);
    editor.endStroke();
    editor.paintHalves(2, 1, 2, 1, false, 3);
    editor.endStroke();
    const at = (x: number) => [...editor.halves!.slice((10 + x) * 2, (10 + x) * 2 + 2)];
    expect([at(1), at(2), at(3)]).toEqual([[2, 0], [2, 3], [2, 0]]);
    expect([editor.extras[2], editor.extras[3]]).toEqual([3, 1]);
    expect(changes.at(-1)).toMatchObject({ fractions: [12], cells: [] });
    expect(editor.counts[2]).toBe(0); // full stitches are untouched
    editor.paintHalves(2, 1, 2, 1, true, 0);
    editor.endStroke();
    expect(at(2)).toEqual([0, 0]);
    editor.undo();
    expect(at(2)).toEqual([2, 3]);
    editor.undo();
    editor.undo();
    expect(editor.extras[2] + editor.extras[3]).toBe(0);
    editor.redo();
    expect(editor.extras[2]).toBe(3);
  });

  it('quarter stitches go to the corner under the pointer', () => {
    const { editor } = setup();
    // Half-cell coordinates: (5, 4) is the right half, top half of cell (2, 2).
    editor.paintQuarters(5, 4, 5, 4, 1);
    editor.paintQuarters(4, 5, 4, 5, 2);
    editor.endStroke();
    expect([...editor.quarters!.slice(22 * 4, 22 * 4 + 4)]).toEqual([0, 1, 2, 0]);
    expect(editor.colorAt(2.75, 2.25, { full: true, fractional: true, backstitch: true })).toBe(1);
    expect(editor.colorAt(2.25, 2.25, { full: true, fractional: true, backstitch: true })).toBe(0);
    // Off the strand, the eyedropper sees through to what is underneath.
    expect(editor.colorAt(2.55, 2.1, { full: true, fractional: true, backstitch: true })).toBe(0);
    editor.undo();
    expect(editor.quarters!.every((v) => v === 0)).toBe(true);
  });

  it('backstitch lines are added, picked, erased and restored in place', () => {
    const { editor } = setup();
    const all = { full: true, fractional: true, backstitch: true };
    editor.addBackstitch({ x0: 0, y0: 0, x1: 8, y1: 0, color: 1 });
    editor.addBackstitch({ x0: 0, y0: 4, x1: 8, y1: 4, color: 2 });
    editor.addBackstitch({ x0: 0, y0: 8, x1: 8, y1: 8, color: 3 });
    editor.addBackstitch({ x0: 3, y0: 3, x1: 3, y1: 3, color: 4 }); // no length: ignored
    expect(editor.backstitches.length).toBe(3);
    expect(editor.colorAt(2, 2.1, all)).toBe(2);
    expect(editor.colorAt(2, 2.1, { ...all, backstitch: false })).toBe(0);
    editor.eraseBackstitchNear(2, 2, 0.3);
    editor.endStroke();
    expect(editor.backstitches.map((l) => l.color)).toEqual([1, 3]);
    expect(editor.extras[2]).toBe(0);
    editor.undo();
    expect(editor.backstitches.map((l) => l.color)).toEqual([1, 2, 3]);
    editor.undo(); // the third line
    expect(editor.backstitches.map((l) => l.color)).toEqual([1, 2]);
    editor.redo();
    editor.redo();
    expect(editor.backstitches.map((l) => l.color)).toEqual([1, 3]);
  });

  it('a locked layer ignores the tools, and only that layer', () => {
    const { editor } = setup();
    editor.setLocked('full', true);
    editor.paintLine(0, 0, 3, 0, 1);
    editor.endStroke();
    editor.fill(0, 2);
    expect(editor.counts[1] + editor.counts[2]).toBe(0);
    expect(editor.canUndo).toBe(false);
    editor.paintHalves(0, 0, 0, 0, true, 1);
    editor.endStroke();
    expect(editor.extras[1]).toBe(1);
    editor.setLocked('fractional', true);
    editor.setLocked('backstitch', true);
    editor.paintQuarters(0, 0, 0, 0, 1);
    editor.addBackstitch({ x0: 0, y0: 0, x1: 2, y1: 2, color: 1 });
    expect(editor.extras[1]).toBe(1);
    expect(editor.backstitches.length).toBe(0);
  });

  it('round brushes are the pixel-art kind; square ones are full squares', () => {
    expect([1, 2, 3, 4, 5].map((n) => brushOffsets(n, 'round').length)).toEqual([1, 4, 5, 12, 21]);
    expect([1, 2, 3, 4].map((n) => brushOffsets(n, 'square').length)).toEqual([1, 4, 9, 16]);
    // Size 3 round is a plus: no corners.
    expect(brushOffsets(3, 'round')).not.toContainEqual([-1, -1]);
  });

  it('a wider brush paints around the line, and erases the same way', () => {
    const { editor, at, countsMatch } = setup(20, 20);
    editor.setBrush(3, 'square');
    editor.paintLine(5, 5, 9, 5, 1);
    editor.endStroke();
    expect(editor.counts[1]).toBe(7 * 3);
    expect([at(4, 4), at(10, 6), at(11, 5), at(5, 7)]).toEqual([1, 1, 0, 0]);
    editor.setBrush(3, 'round');
    editor.paintLine(7, 5, 7, 5, 0);
    editor.endStroke();
    expect(editor.counts[1]).toBe(21 - 5);
    editor.undo();
    editor.undo();
    expect(editor.counts[1]).toBe(0);
    expect(countsMatch()).toBe(true);
  });

  it('rewind takes back the part of a stroke drawn after the mark', () => {
    const { editor, at, countsMatch } = setup();
    editor.paintLine(0, 0, 3, 0, 1);
    const mark = editor.mark();
    editor.paintLine(3, 0, 3, 5, 1);
    editor.paintHalves(6, 6, 7, 6, true, 2);
    editor.rewind(mark);
    expect(editor.counts[1]).toBe(4);
    expect(editor.extras[2]).toBe(0);
    editor.paintLine(3, 0, 8, 0, 1); // the straight line that replaces it
    editor.endStroke();
    expect(editor.counts[1]).toBe(9);
    editor.undo();
    expect([at(0, 0), at(8, 0)]).toEqual([0, 0]);
    expect(countsMatch()).toBe(true);
  });

  it('a gradient fill lays the ramp along the dragged line, inside the connected area only', () => {
    const { editor, at, countsMatch } = setup(10, 4);
    editor.paintLine(0, 3, 9, 3, 5); // bottom row is another colour: not part of the area
    editor.endStroke();
    const ramp = Uint16Array.of(1, 2, 3, 4);
    editor.gradientFill(0, ramp, 0, 0, 10, 0);
    expect([at(1, 0), at(2, 1), at(4, 0), at(5, 2), at(9, 0)]).toEqual([1, 2, 2, 3, 4]);
    expect(at(4, 3)).toBe(5);
    editor.undo();
    expect([at(0, 0), at(9, 2)]).toEqual([0, 0]);
    editor.redo();
    expect(at(9, 2)).toBe(4);
    // Reversed line: reversed gradient. No line (a click): left to right across the area.
    editor.undo();
    editor.gradientFill(0, ramp, 10, 0, 0, 0);
    expect([at(0, 0), at(9, 0)]).toEqual([4, 1]);
    editor.undo();
    editor.gradientFill(15, ramp, 3, 1, 3, 1);
    expect([at(0, 0), at(9, 0)]).toEqual([1, 4]);
    expect(countsMatch()).toBe(true);
  });

  it('copies the selection and pastes it elsewhere, selected, as one step', () => {
    const { editor, at, countsMatch } = setup();
    editor.paintLine(1, 1, 2, 1, 2);
    editor.paintLine(1, 2, 1, 2, 3);
    editor.endStroke();
    editor.selectRect(1, 1, 2, 2, 'replace', null);
    const clip = editor.copySelection()!;
    expect([clip.width, clip.height, [...clip.values]]).toEqual([2, 2, [2, 2, 3, 0]]);
    editor.paste(clip, 6, 4);
    expect([at(6, 4), at(7, 4), at(6, 5), at(7, 5)]).toEqual([2, 2, 3, 0]);
    // Only what was pasted is selected: the empty corner is not.
    expect(editor.selection![4 * 10 + 6]).toBe(1);
    expect(editor.selection![5 * 10 + 7]).toBe(0);
    expect(countsMatch()).toBe(true);
    editor.undo();
    expect([at(6, 4), at(6, 5)]).toEqual([0, 0]);
    // Pasting over the edge keeps what fits.
    editor.paste(clip, 9, 7);
    expect(at(9, 7)).toBe(2);
    expect(countsMatch()).toBe(true);
  });

  it('moves the selected stitches as the pointer drags, and undoes the move as one step', () => {
    const { editor, at, countsMatch } = setup();
    editor.paintLine(1, 1, 2, 1, 2);
    editor.paintLine(5, 1, 5, 1, 4);
    editor.endStroke();
    editor.selectRect(1, 1, 2, 1, 'replace', null);
    editor.dragSelection(1, 0);
    editor.dragSelection(4, 2); // each call is measured from where the drag began
    expect([at(1, 1), at(2, 1), at(5, 3), at(6, 3)]).toEqual([0, 0, 2, 2]);
    expect(at(5, 1)).toBe(4); // what the first position passed over is back
    editor.endStroke();
    expect(editor.selection![3 * 10 + 5]).toBe(1);
    expect(countsMatch()).toBe(true);
    editor.undo();
    expect([at(1, 1), at(2, 1), at(5, 3)]).toEqual([2, 2, 0]);
    editor.redo();
    expect([at(1, 1), at(5, 3)]).toEqual([0, 2]);
    // Moving partly off the chart loses what leaves it.
    editor.dragSelection(4, 0);
    editor.endStroke();
    expect(at(9, 3)).toBe(2);
    expect(editor.counts[2]).toBe(1);
  });

  it('flips and turns the selection inside its own rectangle', () => {
    const { editor, at, countsMatch } = setup();
    // An "L": (2,2) (2,3) (2,4) (3,4)
    editor.paintLine(2, 2, 2, 4, 2);
    editor.paintLine(3, 4, 3, 4, 3);
    editor.endStroke();
    editor.selectRect(2, 2, 3, 4, 'replace', null);
    editor.transformSelection('flipH');
    expect([at(3, 2), at(3, 3), at(3, 4), at(2, 4), at(2, 2)]).toEqual([2, 2, 2, 3, 0]);
    editor.undo();
    editor.transformSelection('flipV');
    expect([at(2, 2), at(3, 2), at(2, 4), at(3, 4)]).toEqual([2, 3, 2, 0]);
    editor.undo();
    editor.transformSelection('rotateCW');
    editor.transformSelection('rotateCCW');
    expect([at(2, 2), at(2, 3), at(2, 4), at(3, 4), at(3, 2)]).toEqual([2, 2, 2, 3, 0]);
    // Four quarter turns bring a square back to where it started.
    editor.selectRect(1, 1, 4, 4, 'replace', null);
    const before = [...editor.grid.cells];
    for (let n = 0; n < 4; n++) editor.transformSelection('rotateCW');
    expect([...editor.grid.cells]).toEqual(before);
    expect(countsMatch()).toBe(true);
  });

  it('with nothing selected, a flip mirrors the whole chart', () => {
    const { editor, at } = setup();
    editor.paintLine(0, 0, 0, 0, 2);
    editor.endStroke();
    editor.transformSelection('flipH');
    expect([at(0, 0), at(9, 0)]).toEqual([0, 2]);
  });

  it('draws rectangles and ellipses, outlined or filled', () => {
    const { editor, at, countsMatch } = setup(12, 12);
    editor.paintShape('rect', 1, 1, 4, 3, 2, false);
    editor.endStroke();
    expect(editor.counts[2]).toBe(10);
    expect([at(1, 1), at(4, 3), at(2, 2)]).toEqual([2, 2, 0]);
    editor.paintShape('rect', 4, 3, 1, 1, 3, true); // corners in any order
    editor.endStroke();
    expect(editor.counts[3]).toBe(12);
    editor.paintShape('ellipse', 0, 5, 6, 11, 4, false);
    editor.endStroke();
    // A circle: its middle is hollow, its corners are cut, the middle of each side is on it.
    expect([at(3, 8), at(0, 5), at(3, 5), at(0, 8), at(6, 8), at(3, 11)]).toEqual([0, 0, 4, 4, 4, 4]);
    editor.paintShape('ellipse', 0, 5, 6, 11, 5, true);
    editor.endStroke();
    expect(at(3, 8)).toBe(5);
    expect(at(0, 5)).toBe(0);
    expect(countsMatch()).toBe(true);
    editor.undo();
    expect(at(3, 8)).toBe(0);
  });

  it('a shape dragged out is redrawn from its start each time', () => {
    const { editor } = setup();
    const mark = editor.mark();
    editor.paintShape('rect', 1, 1, 6, 6, 2, true);
    editor.rewind(mark);
    editor.paintShape('rect', 1, 1, 2, 2, 2, true);
    editor.endStroke();
    expect(editor.counts[2]).toBe(4);
    editor.undo();
    expect(editor.counts[2]).toBe(0);
  });

  it('replaces a colour on every layer in one step', () => {
    const { editor, at } = setup();
    editor.paintLine(0, 0, 3, 0, 2);
    editor.paintHalves(5, 5, 5, 5, true, 2);
    editor.paintQuarters(4, 4, 4, 4, 2);
    editor.endStroke();
    editor.addBackstitch({ x0: 0, y0: 0, x1: 4, y1: 0, color: 2 });
    editor.paintLine(0, 3, 0, 3, 4);
    editor.endStroke();
    editor.replaceColor(2, 5);
    expect([at(0, 0), at(3, 0), at(0, 3)]).toEqual([5, 5, 4]);
    expect(editor.halves![(5 * 10 + 5) * 2]).toBe(5);
    expect(editor.backstitches[0].color).toBe(5);
    expect([editor.counts[2], editor.extras[2], editor.counts[5], editor.extras[5]]).toEqual([0, 0, 4, 3]);
    editor.undo();
    expect([at(0, 0), editor.backstitches[0].color, editor.extras[2], editor.extras[5]]).toEqual([2, 2, 3, 0]);
    // Inside a selection, only what is selected.
    editor.selectRect(0, 0, 1, 0, 'replace', null);
    editor.replaceColor(2, 5);
    expect([at(0, 0), at(1, 0), at(2, 0)]).toEqual([5, 5, 2]);
  });

  it('a three-quarter stitch is the quarter in a corner plus the half across it', () => {
    const { editor } = setup();
    // Top-left corner of cell (2, 1): the quarter is on "\", so the half is "/".
    editor.paintThreeQuarters(4, 2, 4, 2, 3);
    editor.endStroke();
    const i = 1 * 10 + 2;
    expect([...editor.quarters!.slice(i * 4, i * 4 + 4)]).toEqual([3, 0, 0, 0]);
    expect([...editor.halves!.slice(i * 2, i * 2 + 2)]).toEqual([3, 0]);
    // Top-right corner: the half is "\".
    editor.paintThreeQuarters(7, 2, 7, 2, 4);
    editor.endStroke();
    expect([...editor.halves!.slice((i + 1) * 2, (i + 1) * 2 + 2)]).toEqual([0, 4]);
    editor.undo();
    editor.undo();
    expect(editor.extras[3]).toBe(0);
  });

  it('French knots sit on a point, are counted, picked and erased like backstitch', () => {
    const { editor } = setup();
    editor.addKnot(5, 5, 2);
    editor.addKnot(5, 5, 2); // the same knot again adds nothing
    expect(editor.backstitches.length).toBe(1);
    expect(editor.extras[2]).toBe(1);
    expect(editor.colorAt(2.5, 2.5, { full: true, fractional: true, backstitch: true })).toBe(2);
    editor.eraseBackstitchNear(2.5, 2.5, 0.3);
    editor.endStroke();
    expect(editor.backstitches.length).toBe(0);
    editor.undo();
    expect(editor.backstitches.length).toBe(1);
  });

  it('a gradient ramp starts and ends on the two colours and only uses palette threads', () => {
    const palette = makePalette(60);
    const ramp = gradientRamp(palette, 7, 31);
    expect([ramp[0], ramp.at(-1)]).toEqual([7, 31]);
    expect([...ramp].every((v) => v >= 1 && v <= 60)).toBe(true);
    expect(new Set(ramp).size).toBeGreaterThan(2);
  });
});
