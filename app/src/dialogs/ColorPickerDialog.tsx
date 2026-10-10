import { useEffect, useMemo, useRef, useState } from 'react';
import type { Palette, PaletteEntry } from '../core/palette.ts';
import { useI18n } from '../i18n/index.tsx';
import { Dialog } from '../ui/Dialog.tsx';

interface Props {
  palette: Palette;
  selected: number;
  onPick(id: number): void;
  onClose(): void;
}

type View = 'list' | 'grid';
type SortKey = 'color' | 'code' | 'name';

const VIEW_KEY = 'crossing.colorPicker.view';
const SORT_KEYS: SortKey[] = ['color', 'code', 'name'];

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

/**
 * Where a colour falls when sorting "by colour": greys first, light to dark, then the rest
 * around the colour wheel, each hue light to dark.
 */
function colorRank(e: PaletteEntry): number {
  const [L, a, b] = e.lab;
  if (Math.hypot(a, b) < 8) return -1000 - L;
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return Math.round(((hue + 360) % 360) / 15) * 1000 - L;
}

/** Choose a colour from the whole thread palette: a sortable list (or a grid of swatches), with search. */
export function ColorPickerDialog({ palette, selected, onPick, onClose }: Props) {
  const { t, locale } = useI18n();
  const c = t.colorPicker;
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(savedView);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'code', descending: false });
  const body = useRef<HTMLDivElement>(null);

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // The choice simply is not remembered.
    }
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = palette.entries.filter((e) => e.id !== 0 && (q === '' || `${e.brand} ${e.code} ${e.name}`.toLowerCase().includes(q)));
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    // Palette order is catalogue order, which is the order of the codes.
    const compare: Record<SortKey, (a: PaletteEntry, b: PaletteEntry) => number> = {
      code: (a, b) => a.id - b.id,
      name: (a, b) => collator.compare(a.name, b.name) || a.id - b.id,
      color: (a, b) => colorRank(a) - colorRank(b) || a.id - b.id,
    };
    found.sort(compare[sort.key]);
    return sort.descending ? found.reverse() : found;
  }, [palette, query, sort, locale]);

  // Open on the current colour, whichever view is showing.
  useEffect(() => {
    body.current?.querySelector('.selected')?.scrollIntoView({ block: 'center' });
  }, [view]);

  const labels: Record<SortKey, string> = { color: c.color, code: t.colors.code, name: t.colors.name };
  const hints: Record<SortKey, string> = { color: c.sortByColor, code: t.colors.sortByCode, name: t.colors.sortByName };
  const title = (e: PaletteEntry) => `${e.brand} ${e.code} · ${e.name}`;

  return (
    <Dialog title={c.title} onClose={onClose}>
      <div className="form">
        <div className="picker-top">
          <label className="field">
            <span>{c.search}</span>
            <input type="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="picker-views" role="group" aria-label={c.view}>
            {(['list', 'grid'] as const).map((v) => (
              <button key={v} type="button" className={`tool text${view === v ? ' active' : ''}`} aria-pressed={view === v} onClick={() => changeView(v)}>
                {c[v]}
              </button>
            ))}
          </div>
        </div>

        <div className="picker-body" ref={body}>
          {/* The column labels sort in both views; in the grid they are all there is of a header. */}
          <div className="picker-head">
            {SORT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={`colors-sort ${key}${sort.key === key ? ' active' : ''}`}
                aria-pressed={sort.key === key}
                title={hints[key]}
                onClick={() => setSort((s) => ({ key, descending: s.key === key && !s.descending }))}
              >
                {labels[key]}
                <span className="sort-arrow">{sort.key === key ? (sort.descending ? '▼' : '▲') : ''}</span>
              </button>
            ))}
          </div>
          {view === 'list' ? (
            <ul className="picker-list" role="listbox" aria-label={c.title}>
              {matches.map((e) => (
                <li key={e.id}>
                  <button type="button" role="option" aria-selected={selected === e.id} className={`picker-row${selected === e.id ? ' selected' : ''}`} onClick={() => onPick(e.id)}>
                    <i className="swatch" style={{ background: `rgb(${e.rgb.join(',')})` }} />
                    <span className="code">{e.code}</span>
                    <span className="name">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="swatch-grid" role="listbox" aria-label={c.title}>
              {matches.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={selected === e.id}
                  className={`swatch-button${selected === e.id ? ' selected' : ''}`}
                  style={{ background: `rgb(${e.rgb.join(',')})` }}
                  title={title(e)}
                  aria-label={title(e)}
                  onClick={() => onPick(e.id)}
                />
              ))}
            </div>
          )}
        </div>
        <p className="form-note short" role="status">
          {matches.length === 0 ? c.none : c.count(matches.length)}
        </p>
      </div>
    </Dialog>
  );
}
