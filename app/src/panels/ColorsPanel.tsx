import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Palette, PaletteEntry } from '../core/palette.ts';
import { useI18n } from '../i18n/index.tsx';

type SortKey = 'code' | 'name' | 'count';

interface Props {
  palette: Palette;
  /** Stitches per palette index. Updated in place as the chart is edited. */
  counts: Uint32Array;
  /** Half stitches, quarter stitches and backstitch lines per palette index. */
  extras: Uint32Array;
  /** Changes whenever `counts` or `extras` were updated. */
  revision: number;
  selected: number;
  onSelect(id: number): void;
}

const SORT_KEYS: SortKey[] = ['code', 'name', 'count'];

/** One line of the list. Memoized: while drawing, only the rows whose count changed are redone. */
const ColorRow = memo(function ColorRow(props: { entry: PaletteEntry; count: string; extras: string; selected: boolean; onSelect(id: number): void }) {
  const e = props.entry;
  return (
    <li>
      <button type="button" className={`color-row${props.selected ? ' selected' : ''}`} aria-pressed={props.selected} onClick={() => props.onSelect(e.id)}>
        <i className="swatch" style={{ background: `rgb(${e.rgb.join(',')})` }} />
        <span className="code" title={`${e.brand} ${e.code}`}>
          {e.code}
        </span>
        <span className="name" title={e.name}>
          {e.name}
        </span>
        <span className="count" title={props.extras || undefined}>
          {props.count}
          {props.extras && <span className="extras"> +</span>}
        </span>
      </button>
    </li>
  );
});

/** Every colour used in the chart: swatch, number, name and stitch count, sortable by any of the three. */
export const ColorsPanel = memo(function ColorsPanel({ palette, counts, extras, revision, selected, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'code', descending: false });

  const { t, locale, formatNumber } = useI18n();
  const columns: Record<SortKey, { label: string; title: string }> = {
    code: { label: t.colors.code, title: t.colors.sortByCode },
    name: { label: t.colors.name, title: t.colors.sortByName },
    count: { label: t.colors.count, title: t.colors.sortByCount },
  };

  // The colour being drawn with is listed even before its first stitch.
  const used = useMemo(
    () => palette.entries.filter((e) => e.id !== 0 && (counts[e.id] > 0 || extras[e.id] > 0 || e.id === selected)),
    [palette, counts, extras, revision, selected],
  );
  const rows = useMemo(() => {
    // Numbers inside codes and names sort by value ("9" before "10"), in the user's language.
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    const compare: Record<SortKey, (a: PaletteEntry, b: PaletteEntry) => number> = {
      code: (a, b) => collator.compare(a.code, b.code) || collator.compare(a.brand, b.brand),
      name: (a, b) => collator.compare(a.name, b.name),
      count: (a, b) => counts[a.id] - counts[b.id],
    };
    const sorted = [...used].sort((a, b) => compare[sort.key](a, b) || a.id - b.id);
    return sort.descending ? sorted.reverse() : sorted;
  }, [used, counts, revision, sort, locale]);
  const total = useMemo(() => used.reduce((sum, e) => sum + counts[e.id], 0), [used, counts, revision]);

  // Keep the selected colour in sight when it changes from outside (e.g. the eyedropper).
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  // Clicking the active column flips the direction; a new column starts where it reads best.
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, descending: !s.descending } : { key, descending: key === 'count' }));

  return (
    <div className="colors">
      <div className="colors-head" role="row">
        <span />
        {SORT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`colors-sort ${key}${sort.key === key ? ' active' : ''}`}
            title={columns[key].title}
            aria-pressed={sort.key === key}
            onClick={() => sortBy(key)}
          >
            {columns[key].label}
            <span className="sort-arrow">{sort.key === key ? (sort.descending ? '▼' : '▲') : ''}</span>
          </button>
        ))}
      </div>
      <ul className="colors-list" ref={list}>
        {rows.map((e) => (
          <ColorRow
            key={e.id}
            entry={e}
            count={formatNumber(counts[e.id])}
            extras={extras[e.id] > 0 ? t.colors.extras(formatNumber(extras[e.id])) : ''}
            selected={selected === e.id}
            onSelect={onSelect}
          />
        ))}
      </ul>
      <div className="colors-foot">
        {used.length === 0 ? t.colors.empty : t.colors.summary(used.length, total, formatNumber)}
      </div>
    </div>
  );
});
