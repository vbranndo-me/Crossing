import { useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { DEFAULT_FABRIC_COUNT, FABRIC_COUNTS, MAX_SIDE, finishedCm } from '../project.ts';
import { BRANDS, BRAND_IDS, DEFAULT_BRAND } from '../threads/brands.ts';
import type { BrandId } from '../threads/brands.ts';
import { Dialog } from '../ui/Dialog.tsx';

interface Props {
  onCreate(name: string, width: number, height: number, fabricCount: number, brand: BrandId): void;
  onClose(): void;
}

const DEFAULT_SIDE = 100;

/** Whole number of stitches within the allowed range, or null. */
function parseSide(text: string): number | null {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value >= 1 && value <= MAX_SIDE ? value : null;
}

/** File > New: name, size in stitches and fabric count of a blank chart. */
export function NewChartDialog({ onCreate, onClose }: Props) {
  const { t, locale } = useI18n();
  const n = t.newChart;
  const [name, setName] = useState(n.defaultName);
  const [width, setWidth] = useState(String(DEFAULT_SIDE));
  const [height, setHeight] = useState(String(DEFAULT_SIDE));
  const [count, setCount] = useState(DEFAULT_FABRIC_COUNT);
  const [brand, setBrand] = useState<BrandId>(DEFAULT_BRAND);

  const w = parseSide(width);
  const h = parseSide(height);
  const valid = w !== null && h !== null;
  const one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onCreate(name.trim() || n.defaultName, w, h, count, brand);
  };

  return (
    <Dialog title={n.title} onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span>{n.name}</span>
          <input type="text" value={name} maxLength={80} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{n.width}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={width} aria-invalid={w === null} onChange={(e) => setWidth(e.target.value)} />
          </label>
          <label className="field">
            <span>{n.height}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={height} aria-invalid={h === null} onChange={(e) => setHeight(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>{t.threads.brand}</span>
          <select value={brand} onChange={(e) => setBrand(e.target.value as BrandId)}>
            {BRAND_IDS.map((id) => (
              <option key={id} value={id}>
                {t.threads.option(BRANDS[id].name, BRANDS[id].colors.length)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{n.fabric}</span>
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {FABRIC_COUNTS.map((c) => (
              <option key={c} value={c}>
                {n.fabricCount(c)}
              </option>
            ))}
          </select>
        </label>
        <p className={`form-note${valid ? '' : ' error'}`} role="status">
          {valid
            ? n.finishedSize(one.format(finishedCm(w, count)), one.format(finishedCm(h, count)), one.format(w / count), one.format(h / count))
            : n.rangeError(MAX_SIDE)}
        </p>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {n.cancel}
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            {n.create}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
