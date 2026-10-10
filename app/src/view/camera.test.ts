import { describe, expect, it } from 'vitest';
import { MAX_SCALE, cellAt, clamp, fit, minScale, panBy, zoomAt } from './camera.ts';

const grid = { width: 1000, height: 1000 };
const view = { width: 1280, height: 720 };

describe('camera', () => {
  it('fit shows the whole grid, centred', () => {
    const cam = fit(grid, view);
    expect(cam.scale * grid.height).toBeLessThanOrEqual(view.height);
    expect(cam.x + view.width / cam.scale / 2).toBeCloseTo(500);
    expect(cam.y + view.height / cam.scale / 2).toBeCloseTo(500);
  });

  it('zoom keeps the point under the cursor fixed', () => {
    const cam = { x: 300, y: 400, scale: 8 };
    const before = { x: cam.x + 200 / cam.scale, y: cam.y + 150 / cam.scale };
    const next = zoomAt(cam, 1.5, 200, 150, grid, view);
    expect(next.scale).toBeCloseTo(12);
    expect(next.x + 200 / next.scale).toBeCloseTo(before.x);
    expect(next.y + 150 / next.scale).toBeCloseTo(before.y);
  });

  it('zoom stops at the limits', () => {
    const cam = fit(grid, view);
    expect(zoomAt(cam, 1e6, 0, 0, grid, view).scale).toBe(MAX_SCALE);
    expect(zoomAt(cam, 1e-6, 0, 0, grid, view).scale).toBe(minScale(grid, view));
  });

  it('pan cannot push the grid out of sight', () => {
    const cam = panBy({ x: 0, y: 0, scale: 16 }, 1e6, 1e6, grid, view);
    expect(cam.x + view.width / cam.scale / 2).toBeCloseTo(0);
    expect(cam.y + view.height / cam.scale / 2).toBeCloseTo(0);
    expect(clamp(cam, grid, view)).toEqual(cam);
  });

  it('maps viewport positions to cells', () => {
    const cam = { x: 10, y: 20, scale: 16 };
    expect(cellAt(cam, 0, 0, grid)).toEqual({ x: 10, y: 20 });
    expect(cellAt(cam, 31, 17, grid)).toEqual({ x: 11, y: 21 });
    expect(cellAt({ x: -5, y: 0, scale: 16 }, 0, 0, grid)).toBeNull();
  });
});
