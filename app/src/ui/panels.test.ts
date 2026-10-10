import { describe, expect, it } from 'vitest';
import { clampDockSize, fitToWorkspace, insertDocked, splitColumn } from './panels.ts';

describe('panels', () => {
  it('splits a column by weight and fills it exactly', () => {
    const parts = splitColumn([{ weight: 1, collapsed: false }, { weight: 2, collapsed: false }, { weight: 1, collapsed: true }], 631, 29);
    expect(parts.map(([, h]) => h)).toEqual([201, 401, 29]);
    expect(parts.map(([y]) => y)).toEqual([0, 201, 602]);
  });

  it('gives collapsed panels only their title bar', () => {
    expect(splitColumn([{ weight: 1, collapsed: true }, { weight: 1, collapsed: false }], 500, 29)).toEqual([
      [0, 29],
      [29, 471],
    ]);
  });

  it('inserts a docked panel relative to the visible ones', () => {
    // "b" is closed (not visible): dropping before the 2nd visible panel means before "c".
    expect(insertDocked(['a', 'b', 'c'], 'x', ['a', 'c'], 1)).toEqual(['a', 'b', 'x', 'c']);
    expect(insertDocked(['a', 'b', 'c'], 'x', ['a', 'c'], 2)).toEqual(['a', 'b', 'c', 'x']);
    expect(insertDocked(['a', 'b', 'c'], 'c', ['a', 'b', 'c'], 0)).toEqual(['c', 'a', 'b']);
  });

  it('keeps floating panels reachable and docks within their share', () => {
    const ws = { width: 800, height: 600 };
    expect(fitToWorkspace({ x: 900, y: 900, width: 300, height: 200 }, { width: 100, height: 100 }, ws)).toEqual({ x: 500, y: 572, width: 300, height: 200 });
    expect(clampDockSize('left', 1000, ws)).toBe(320);
    expect(clampDockSize('right', 50, ws)).toBe(180);
    expect(clampDockSize('bottom', 1000, ws)).toBe(240);
    expect(clampDockSize('bottom', 10, ws)).toBe(100);
  });
});
