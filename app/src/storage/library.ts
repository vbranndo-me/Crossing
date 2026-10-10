import type { Backstitch } from '../edit/editor.ts';

/**
 * The library: every saved chart, kept in this browser (IndexedDB).
 * Nothing outside this file knows where charts are stored, so a desktop build can keep them
 * as files on disk, or a cloud backend can be added, by replacing these functions.
 */

/** What the library screen needs to list a chart, without loading its stitches. */
export interface LibraryEntry {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Thread brand id (see threads/brands.ts). Missing in charts saved before brands existed. */
  brand?: string;
  fabricCount: number;
  createdAt: number;
  updatedAt: number;
  /** Small picture of the chart (PNG), or null if it could not be made. */
  thumbnail: Blob | null;
}

/** The stitches of a chart, one field per layer. */
export interface ChartData {
  id: string;
  /**
   * Thread code of every palette index at the time of saving (position 0 is the empty cell).
   * Stitches are stored as indices; this is what lets them survive a change to the brand's table.
   */
  codes?: string[];
  cells: Uint16Array;
  quarters: Uint16Array | null;
  halves: Uint16Array | null;
  backstitches: Backstitch[];
}

const DB_NAME = 'crossing';
const ENTRIES = 'entries';
const CHARTS = 'charts';

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ENTRIES, { keyPath: 'id' });
      request.result.createObjectStore(CHARTS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    opening = null; // let the next call try again
    throw error;
  });
  return opening;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Run `work` in one transaction over both stores; resolves once everything is committed. */
async function transact<T>(mode: IDBTransactionMode, work: (entries: IDBObjectStore, charts: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const tx = (await database()).transaction([ENTRIES, CHARTS], mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const result = await work(tx.objectStore(ENTRIES), tx.objectStore(CHARTS));
  await committed;
  return result;
}

/** Every saved chart, most recently edited first. */
export async function listEntries(): Promise<LibraryEntry[]> {
  const entries = await transact('readonly', (store) => done<LibraryEntry[]>(store.getAll()));
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadChart(id: string): Promise<{ entry: LibraryEntry; data: ChartData } | null> {
  return transact('readonly', async (entries, charts) => {
    const [entry, data] = await Promise.all([done<LibraryEntry | undefined>(entries.get(id)), done<ChartData | undefined>(charts.get(id))]);
    return entry && data ? { entry, data } : null;
  });
}

/** Create or replace a chart. */
export function saveChart(entry: LibraryEntry, data: ChartData): Promise<void> {
  return transact('readwrite', (entries, charts) => {
    entries.put(entry);
    charts.put(data);
  });
}

export function renameChart(id: string, name: string): Promise<void> {
  return transact('readwrite', async (entries) => {
    const entry = await done<LibraryEntry | undefined>(entries.get(id));
    if (entry) entries.put({ ...entry, name });
  });
}

/** Copy a chart under a new name. Returns the id of the copy, or null if the original is gone. */
export function duplicateChart(id: string, name: string): Promise<string | null> {
  return transact('readwrite', async (entries, charts) => {
    const [entry, data] = await Promise.all([done<LibraryEntry | undefined>(entries.get(id)), done<ChartData | undefined>(charts.get(id))]);
    if (!entry || !data) return null;
    const copy = crypto.randomUUID();
    const now = Date.now();
    entries.put({ ...entry, id: copy, name, createdAt: now, updatedAt: now });
    charts.put({ ...data, id: copy });
    return copy;
  });
}

export function deleteChart(id: string): Promise<void> {
  return transact('readwrite', (entries, charts) => {
    entries.delete(id);
    charts.delete(id);
  });
}
