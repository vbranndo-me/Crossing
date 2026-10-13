import { useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { MAX_SIDE } from '../project.ts';
import { Dialog } from '../ui/Dialog.tsx';

interface Props {
  width: number;
  height: number;
  /** New size, and where the current chart's top-left corner lands on it (in cells; negative crops). */
  onResize(width: number, height: number, dx: number, dy: number): void;
  onClose(): void;
}

const side = (text: string) => (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= MAX_SIDE ? Number(text) : null);

/** Chart > Chart size: make the canvas larger or smaller, keeping the stitches anchored to a side or corner. */
export function ChartSizeDialog({ width, height, onResize, onClose }: Props) {
  const { t } = useI18n();
  const d = t.chartSize;
  const [widthText, setWidthText] = useState(String(width));
  const [heightText, setHeightText] = useState(String(height));
  /** Which part of the chart stays put: 0, 1 or 2 (start, middle, end) each way. */
  const [anchor, setAnchor] = useState({ x: 1, y: 1 });
  const w = side(widthText);
  const h = side(heightText);
  const valid = w !== null && h !== null;
  const loses = valid && (w < width || h < height);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onResize(w, h, Math.round(((w - width) * anchor.x) / 2), Math.round(((h - height) * anchor.y) / 2));
  };

  return (
    <Dialog title={d.title} onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field-row">
          <label className="field">
            <span>{t.newChart.width}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={widthText} autoFocus aria-invalid={w === null} onChange={(e) => setWidthText(e.target.value)} />
          </label>
          <label className="field">
            <span>{t.newChart.height}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={heightText} aria-invalid={h === null} onChange={(e) => setHeightText(e.target.value)} />
          </label>
        </div>
        <div className="field">
          <span>{d.anchor}</span>
          <div className="anchor-grid" role="group" aria-label={d.anchor}>
            {[0, 1, 2].flatMap((y) =>
              [0, 1, 2].map((x) => (
                <button
                  key={`${x}${y}`}
                  type="button"
                  className={`tool${anchor.x === x && anchor.y === y ? ' active' : ''}`}
                  aria-pressed={anchor.x === x && anchor.y === y}
                  aria-label={d.anchors[y][x]}
                  title={d.anchors[y][x]}
                  onClick={() => setAnchor({ x, y })}
                />
              )),
            )}
          </div>
        </div>
        <p className={`form-note${valid ? '' : ' error'}`} role="status">
          {!valid ? t.newChart.rangeError(MAX_SIDE) : loses ? d.loses : d.note}
        </p>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t.newChart.cancel}
          </button>
          <button type="submit" className="button primary" disabled={!valid || (w === width && h === height)}>
            {d.apply}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
