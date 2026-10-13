import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Palette } from '../core/palette.ts';
import { useI18n } from '../i18n/index.tsx';
import { Dialog } from '../ui/Dialog.tsx';

interface Props {
  palette: Palette;
  /** Palette indices that have stitches in the chart. */
  used: number[];
  /** The colour to offer first as the one to replace. */
  initial: number;
  /** There is a selection: only what is inside it will change. */
  inSelection: boolean;
  onReplace(from: number, to: number): void;
  onClose(): void;
}

/** Chart > Replace colour: every stitch of one thread becomes another. */
export function ReplaceColorDialog({ palette, used, initial, inSelection, onReplace, onClose }: Props) {
  const { t } = useI18n();
  const d = t.replaceColor;
  const [from, setFrom] = useState(used.includes(initial) ? initial : (used[0] ?? 0));
  const [to, setTo] = useState(initial !== from ? initial : 1);
  const label = (index: number) => `${palette.entries[index].code} · ${palette.entries[index].name}`;
  const swatch = (index: number) => <i className="swatch" style={{ background: `rgb(${palette.entries[index].rgb.join(',')})` }} />;
  const valid = from !== 0 && to !== 0 && from !== to;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onReplace(from, to);
  };

  return (
    <Dialog title={d.title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {used.length === 0 ? (
          <p className="form-note">{d.empty}</p>
        ) : (
          <>
            <label className="field">
              <span>{d.from}</span>
              <span className="swatch-select">
                {swatch(from)}
                <select value={from} autoFocus onChange={(e) => setFrom(Number(e.target.value))}>
                  {used.map((index) => (
                    <option key={index} value={index}>
                      {label(index)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="field">
              <span>{d.to}</span>
              <span className="swatch-select">
                {swatch(to)}
                <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
                  {palette.entries.slice(1).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {label(entry.id)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <p className="form-note">{inSelection ? d.inSelection : d.everywhere}</p>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t.newChart.cancel}
          </button>
          <button type="submit" className="button primary" disabled={!valid || used.length === 0}>
            {d.apply}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
