import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from './i18n/index.tsx';
import { deleteChart, duplicateChart, listEntries, renameChart } from './storage/library.ts';
import type { LibraryEntry } from './storage/library.ts';
import { BRANDS, brandOf } from './threads/brands.ts';
import { Dialog } from './ui/Dialog.tsx';

interface Props {
  onNew(): void;
  onImport(): void;
  onOpen(id: string): void;
  onSample(): void;
}

/** Shows a thumbnail blob, releasing its URL when it changes or goes away. */
function Thumbnail({ blob, pixelated }: { blob: Blob | null; pixelated: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return <span className="chart-thumb">{blob && url && <img src={url} alt="" className={pixelated ? 'pixelated' : undefined} />}</span>;
}

/** The library: every saved chart, with what can be done to each one. */
export function LibraryScreen({ onNew, onImport, onOpen, onSample }: Props) {
  const { t, locale } = useI18n();
  const l = t.library;
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<LibraryEntry | null>(null);

  const refresh = useCallback(() => listEntries().then(setEntries, () => setFailed(true)), []);
  useEffect(() => {
    document.title = `${l.title} · Crossing`;
    void refresh();
  }, [refresh, l.title]);

  /** Run a library operation, then show the list as it now is. */
  const change = (work: Promise<unknown>) => work.then(refresh, () => setFailed(true));

  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || !name.trim()) return;
    void change(renameChart(renaming.id, name.trim()));
    setRenaming(null);
  };

  return (
    <div className="library">
      <header className="library-head">
        <h1>{l.title}</h1>
        <span className="spacer" />
        <button type="button" className="button" onClick={onSample}>
          {l.sample}
        </button>
        <button type="button" className="button" onClick={onImport}>
          {l.importImage}
        </button>
        <button type="button" className="button primary" onClick={onNew}>
          {l.new}
        </button>
      </header>
      <main className="library-body">
        {failed ? (
          <p className="notice">{l.loadError}</p>
        ) : entries === null ? null : entries.length === 0 ? (
          <div className="notice">
            <p>{l.empty}</p>
            <button type="button" className="button primary" onClick={onNew}>
              {l.new}
            </button>
          </div>
        ) : (
          <ul className="chart-list">
            {entries.map((entry) => (
              <li key={entry.id} className="chart-card">
                <button type="button" className="chart-open" onClick={() => onOpen(entry.id)} aria-label={l.open(entry.name)}>
                  {/* Small charts are stored one pixel per stitch: keep their pixels sharp when enlarged. */}
                  <Thumbnail blob={entry.thumbnail} pixelated={Math.max(entry.width, entry.height) < 192} />
                  <strong className="chart-name">{entry.name}</strong>
                  <span className="chart-meta">
                    {l.size(entry.width, entry.height)} · {BRANDS[brandOf(entry.brand)].name}
                  </span>
                  <span className="chart-meta">{l.edited(date.format(entry.updatedAt))}</span>
                </button>
                <div className="chart-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setName(entry.name);
                      setRenaming(entry);
                    }}
                  >
                    {l.rename}
                  </button>
                  <button type="button" onClick={() => void change(duplicateChart(entry.id, l.copyOf(entry.name)))}>
                    {l.duplicate}
                  </button>
                  <button type="button" onClick={() => setDeleting(entry)}>
                    {l.delete}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      <footer className="library-foot">{l.localNote}</footer>

      {renaming && (
        <Dialog title={l.renameTitle} onClose={() => setRenaming(null)}>
          <form className="form" onSubmit={submitRename}>
            <label className="field">
              <span>{t.newChart.name}</span>
              <input type="text" value={name} maxLength={80} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={() => setRenaming(null)}>
                {t.newChart.cancel}
              </button>
              <button type="submit" className="button primary" disabled={!name.trim()}>
                {l.rename}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog title={l.deleteTitle} onClose={() => setDeleting(null)}>
          <div className="form">
            <p className="form-text">{l.deleteConfirm(deleting.name)}</p>
            <div className="form-actions">
              <button type="button" className="button" autoFocus onClick={() => setDeleting(null)}>
                {t.newChart.cancel}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  void change(deleteChart(deleting.id));
                  setDeleting(null);
                }}
              >
                {l.delete}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
