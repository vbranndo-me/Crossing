import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Grid } from '../core/grid.ts';
import { useI18n } from '../i18n/index.tsx';
import type { Palette } from '../core/palette.ts';

interface Props {
  grid: Grid;
  palette: Palette;
  /** Changes whenever cells of the grid were edited; `dirty` then says which ones. */
  revision: number;
  dirty: { readonly current: { cells: number[]; all: boolean } };
  /** Part of the chart shown in the main view, in cells. */
  viewRect: { x: number; y: number; width: number; height: number };
  /** Click or drag on the preview: centre the main view on this grid position. */
  onNavigate(x: number, y: number): void;
}

/** The whole chart as an image (one pixel per stitch), with a frame marking what the main view shows. */
export const PreviewPanel = memo(function PreviewPanel({ grid, palette, revision, dirty, viewRect, onNavigate }: Props) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0);

  const picture = useRef<{ image: ImageData; pixels: Uint32Array; lut: Uint32Array; paintAll(): void } | null>(null);

  // Whole image: once per chart.
  useEffect(() => {
    const { width, height, cells } = grid;
    const image = new ImageData(width, height);
    const pixels = new Uint32Array(image.data.buffer);
    const lut = new Uint32Array(palette.size + 1);
    for (let i = 0; i <= palette.size; i++) {
      lut[i] = 0xff000000 | (palette.rgb[i * 3 + 2] << 16) | (palette.rgb[i * 3 + 1] << 8) | palette.rgb[i * 3];
    }
    const paintAll = () => {
      for (let i = 0; i < cells.length; i++) pixels[i] = lut[cells[i]];
      canvas.current!.getContext('2d')!.putImageData(image, 0, 0);
    };
    paintAll();
    picture.current = { image, pixels, lut, paintAll };
  }, [grid, palette]);

  // Edits: repaint only the rectangle around the cells that changed, or everything after a big change.
  useEffect(() => {
    const p = picture.current;
    if (!p) return;
    if (dirty.current.all) {
      p.paintAll();
      return;
    }
    if (dirty.current.cells.length === 0) return;
    const { width, cells } = grid;
    let x0 = width;
    let y0 = grid.height;
    let x1 = 0;
    let y1 = 0;
    for (const i of dirty.current.cells) {
      p.pixels[i] = p.lut[cells[i]];
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    canvas.current!.getContext('2d')!.putImageData(p.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }, [revision, dirty, grid]);

  // Largest size that fits the panel while keeping the chart's proportions.
  useEffect(() => {
    const el = box.current!;
    const measure = () => setScale(Math.max(0, Math.min(el.clientWidth / grid.width, el.clientHeight / grid.height)));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [grid]);

  const navigate = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    onNavigate(((e.clientX - r.left) / r.width) * grid.width, ((e.clientY - r.top) / r.height) * grid.height);
  };

  // The frame, clipped to the chart, as fractions of the image.
  const left = Math.max(0, viewRect.x) / grid.width;
  const top = Math.max(0, viewRect.y) / grid.height;
  const right = Math.min(grid.width, viewRect.x + viewRect.width) / grid.width;
  const bottom = Math.min(grid.height, viewRect.y + viewRect.height) / grid.height;

  return (
    <div className="preview" ref={box}>
      <div
        className="preview-image"
        style={{ width: grid.width * scale, height: grid.height * scale }}
        onPointerDown={navigate}
        onPointerMove={navigate}
        title={t.preview.navigate}
      >
        <canvas ref={canvas} width={grid.width} height={grid.height} className={scale >= 1 ? 'pixelated' : undefined} />
        {right > left && bottom > top && (
          <div
            className="preview-frame"
            style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
});
