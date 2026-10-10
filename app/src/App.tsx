import { useState } from 'react';
import { ChartScreen } from './ChartScreen.tsx';
import { LibraryScreen } from './LibraryScreen.tsx';
import { ImportImageDialog } from './dialogs/ImportImageDialog.tsx';
import type { ImportedChart } from './dialogs/ImportImageDialog.tsx';
import { NewChartDialog } from './dialogs/NewChartDialog.tsx';
import { useI18n } from './i18n/index.tsx';
import { newProject, openProject, projectFrom, sampleProject, saveProject } from './project.ts';
import type { Project } from './project.ts';
import { DEFAULT_BRAND, paletteFor } from './threads/brands.ts';
import type { BrandId } from './threads/brands.ts';

/** The app is either the library or one open chart. */
export function App() {
  const { t } = useI18n();
  /** The open chart, with a number that changes every time one is opened (even the same one again). */
  const [open, setOpen] = useState<{ project: Project; session: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const show = (project: Project) => setOpen((now) => ({ project, session: (now?.session ?? 0) + 1 }));

  /** Open a chart that is new to the library (just created, or converted to another brand). */
  const showSaved = async (project: Project) => {
    // In the library from the start, so it is there even if nothing is drawn. If this fails, the
    // chart still opens and its save indicator will show the problem.
    await saveProject(project).catch(() => {});
    show(project);
  };

  const create = (name: string, width: number, height: number, fabricCount: number, brand: BrandId) => {
    setCreating(false);
    void showSaved(newProject(name, width, height, fabricCount, brand));
  };

  const createFromImage = (chart: ImportedChart) => {
    setImporting(false);
    const grid = { width: chart.width, height: chart.height, cells: chart.cells };
    void showSaved(projectFrom(chart.name, grid, chart.fabricCount, chart.brand));
  };

  const openFromLibrary = async (id: string) => {
    const project = await openProject(id).catch(() => null);
    if (project) show(project);
  };

  const sample = (size: number, brand: BrandId) => show(sampleProject(t.menu.sampleChart(size), size, brand));

  return (
    <>
      {open ? (
        <ChartScreen
          key={open.session}
          project={open.project}
          palette={paletteFor(open.project.brand)}
          onNew={() => setCreating(true)}
          onImport={() => setImporting(true)}
          onLibrary={() => setOpen(null)}
          onSample={(size) => sample(size, open.project.brand)}
          onReplace={(project) => void showSaved(project)}
        />
      ) : (
        <LibraryScreen onNew={() => setCreating(true)} onImport={() => setImporting(true)} onOpen={(id) => void openFromLibrary(id)} onSample={() => sample(1000, DEFAULT_BRAND)} />
      )}
      {importing && <ImportImageDialog onCreate={createFromImage} onClose={() => setImporting(false)} />}
      {creating && <NewChartDialog onCreate={create} onClose={() => setCreating(false)} />}
    </>
  );
}
