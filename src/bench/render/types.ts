import type { Grid } from '../../core/grid.ts';
import type { Palette } from '../../core/palette.ts';

/** Top-left corner of the view in grid cells, and pixels per cell. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Renderer {
  /** Draw a whole frame. */
  render(cam: Camera): void;
  /** A single cell changed (grid.cells is already updated). */
  cellChanged(index: number): void;
  /** Repaint after cellChanged calls: only the dirty area where the strategy supports it. */
  flush(cam: Camera): void;
  /** Many cells changed: rebuild whatever is cached. */
  gridChanged(): void;
  /** Bytes held by cached layers and textures (excluding the visible canvas). */
  layerBytes(): number;
}

export type Strategy = 's1' | 's2' | 's3';
export type RendererFactory = (canvas: HTMLCanvasElement, grid: Grid, palette: Palette) => Renderer;

export const BACKGROUND = '#888888';
/** Grid lines are drawn from this cell size up, symbols from SYMBOL_MIN_PX up. */
export const LINES_MIN_PX = 4;
export const SYMBOL_MIN_PX = 12;
export const SYMBOL_FONT = '"Segoe UI Symbol", "DejaVu Sans", sans-serif';

export const css = (p: Palette, i: number) => `rgb(${p.rgb[i * 3]},${p.rgb[i * 3 + 1]},${p.rgb[i * 3 + 2]})`;
