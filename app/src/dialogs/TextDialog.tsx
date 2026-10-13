import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { MAX_SIDE } from '../project.ts';
import { Dialog } from '../ui/Dialog.tsx';

/** Text as stitches: which cells of a `width` x `height` rectangle are on. */
export interface TextStitches {
  width: number;
  height: number;
  on: Uint8Array;
}

interface Props {
  onPlace(text: TextStitches): void;
  onClose(): void;
}

/** Font families every browser has something for. */
const FONTS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'] as const;
const MIN_SIZE = 5;
const MAX_SIZE = 200;
/** A pixel becomes a stitch from this much coverage (0 to 255): a little under half, so thin strokes survive. */
const INK = 100;

/**
 * Draw text with the browser's own fonts and keep the pixels that are covered enough:
 * one pixel, one stitch. Returns null when there is nothing to show or it would not fit a chart.
 */
export function textToStitches(text: string, family: string, size: number, bold: boolean): TextStitches | null {
  const lines = text.split('\n');
  const font = `${bold ? 'bold ' : ''}${size}px ${family}`;
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  probe.font = font;
  const lineHeight = Math.ceil(size * 1.25);
  const width = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width))) + 4;
  const height = lineHeight * lines.length + 4;
  if (!text.trim() || width > MAX_SIDE * 2 || height > MAX_SIDE * 2) return null;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  ctx.font = font;
  ctx.textBaseline = 'top';
  lines.forEach((l, k) => ctx.fillText(l, 2, 2 + k * lineHeight));
  const { data } = ctx.getImageData(0, 0, width, height);
  // Keep only the rectangle that has ink.
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < INK) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0 || x1 - x0 + 1 > MAX_SIDE || y1 - y0 + 1 > MAX_SIDE) return null;
  const out = { width: x1 - x0 + 1, height: y1 - y0 + 1, on: new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1)) };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (data[(y * width + x) * 4 + 3] >= INK) out.on[(y - y0) * out.width + x - x0] = 1;
  return out;
}

/** The text tool: type something, see it in stitches, place it on the chart. */
export function TextDialog({ onPlace, onClose }: Props) {
  const { t } = useI18n();
  const d = t.textTool;
  const [text, setText] = useState('');
  const [family, setFamily] = useState<string>(FONTS[0]);
  const [size, setSize] = useState(12);
  const [bold, setBold] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stitches = useMemo(() => textToStitches(text, family, size, bold), [text, family, size, bold]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !stitches) return;
    el.width = stitches.width;
    el.height = stitches.height;
    const image = new ImageData(stitches.width, stitches.height);
    for (let i = 0; i < stitches.on.length; i++) if (stitches.on[i]) image.data.set([236, 232, 242, 255], i * 4);
    el.getContext('2d')!.putImageData(image, 0, 0);
  }, [stitches]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stitches) onPlace(stitches);
  };

  return (
    <Dialog title={d.title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{d.text}</span>
          <textarea rows={2} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{d.font}</span>
            <select value={family} onChange={(e) => setFamily(e.target.value)}>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {d.fonts[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{d.size}</span>
            <input type="number" min={MIN_SIZE} max={MAX_SIZE} value={size} onChange={(e) => setSize(Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(Number(e.target.value)) || MIN_SIZE)))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} />
          <span>{d.bold}</span>
        </label>
        <div className="text-preview">{stitches && <canvas ref={canvas} />}</div>
        <p className="form-note" role="status">
          {stitches ? d.result(stitches.width, stitches.height) : d.empty}
        </p>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t.newChart.cancel}
          </button>
          <button type="submit" className="button primary" disabled={!stitches}>
            {d.place}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
