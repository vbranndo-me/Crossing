/** Top-left corner of the view in grid cells, and CSS pixels per cell. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MAX_SCALE = 64;
/** Fraction of the viewport left free around the grid by "fit". */
const FIT_MARGIN = 0.95;

/** Scale at which the whole grid fits in the viewport. */
export function fitScale(grid: Size, view: Size): number {
  return Math.min(view.width / grid.width, view.height / grid.height) * FIT_MARGIN;
}

/** The furthest you can zoom out: half the fit size, so the grid never becomes a speck. */
export function minScale(grid: Size, view: Size): number {
  return Math.min(fitScale(grid, view) / 2, 1);
}

/** Keep the scale in range and the centre of the viewport inside the grid. */
export function clamp(cam: Camera, grid: Size, view: Size): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(grid, view), cam.scale));
  const halfW = view.width / scale / 2;
  const halfH = view.height / scale / 2;
  return {
    scale,
    x: Math.min(grid.width - halfW, Math.max(-halfW, cam.x)),
    y: Math.min(grid.height - halfH, Math.max(-halfH, cam.y)),
  };
}

/** Whole grid centred in the viewport. */
export function fit(grid: Size, view: Size): Camera {
  const scale = fitScale(grid, view);
  return { scale, x: (grid.width - view.width / scale) / 2, y: (grid.height - view.height / scale) / 2 };
}

/** Move the view by a distance in CSS pixels (positive = content moves right/down). */
export function panBy(cam: Camera, dx: number, dy: number, grid: Size, view: Size): Camera {
  return clamp({ ...cam, x: cam.x - dx / cam.scale, y: cam.y - dy / cam.scale }, grid, view);
}

/** Zoom by `factor`, keeping the grid point under the viewport position (px, py) where it is. */
export function zoomAt(cam: Camera, factor: number, px: number, py: number, grid: Size, view: Size): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(grid, view), cam.scale * factor));
  const gx = cam.x + px / cam.scale;
  const gy = cam.y + py / cam.scale;
  return clamp({ scale, x: gx - px / scale, y: gy - py / scale }, grid, view);
}

/** Grid cell under a viewport position, or null outside the grid. */
export function cellAt(cam: Camera, px: number, py: number, grid: Size): { x: number; y: number } | null {
  const x = Math.floor(cam.x + px / cam.scale);
  const y = Math.floor(cam.y + py / cam.scale);
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height ? { x, y } : null;
}
