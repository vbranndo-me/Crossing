import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Palette } from './core/palette.ts';
import { ColorPickerDialog } from './dialogs/ColorPickerDialog.tsx';
import { ThreadsDialog } from './dialogs/ThreadsDialog.tsx';
import { MAX_BRUSH, createEditor } from './edit/editor.ts';
import { gradientRamp } from './edit/gradient.ts';
import type { LayerId } from './edit/editor.ts';
import { LOCALES, useI18n } from './i18n/index.tsx';
import { ColorsPanel } from './panels/ColorsPanel.tsx';
import { LayersPanel } from './panels/LayersPanel.tsx';
import type { LayerState } from './panels/LayersPanel.tsx';
import { PreviewPanel } from './panels/PreviewPanel.tsx';
import { convertProject, saveProject } from './project.ts';
import type { Project } from './project.ts';
import { createAutosaver } from './storage/autosave.ts';
import type { SaveState } from './storage/autosave.ts';
import { DEFAULT_TOOL, LAYER_OF, STITCHES, TOOLS } from './tools.ts';
import type { StitchId, ToolId } from './tools.ts';
import { MenuBar } from './ui/MenuBar.tsx';
import type { Menu } from './ui/MenuBar.tsx';
import { defaultColors } from './threads/brands.ts';
import { ToolOptions } from './ui/ToolOptions.tsx';
import type { ToolSettings } from './ui/ToolOptions.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { Workspace } from './ui/Workspace.tsx';
import { usePanels } from './ui/panels.ts';
import type { PanelDef } from './ui/panels.ts';
import { GridView } from './view/GridView.tsx';
import type { GridViewHandle, ViewInfo } from './view/GridView.tsx';

// Generated sample charts, for trying the app with a full grid.
export const SAMPLE_SIZES = [200, 500, 1000];
const ZOOM_STEP = 1.5;
const EDGE = 8;

/**
 * The panel registry. A new panel is one entry here, its title in the i18n files (panels.<id>)
 * and its content in `panelContent` below.
 */
const PANELS: PanelDef[] = [
  {
    id: 'colors',
    min: { width: 220, height: 140 },
    dock: 'left',
    float: (ws) => ({ x: EDGE, y: EDGE, width: 290, height: Math.min(560, ws.height - 2 * EDGE) }),
  },
  {
    id: 'preview',
    min: { width: 140, height: 120 },
    dock: 'right',
    float: (ws) => ({ x: ws.width - 270 - EDGE, y: EDGE, width: 270, height: Math.min(300, ws.height - 2 * EDGE) }),
  },
  {
    id: 'layers',
    min: { width: 190, height: 120 },
    dock: 'right',
    float: (ws) => ({ x: ws.width - 270 - EDGE, y: 320, width: 270, height: 150 }),
  },
];

interface Props {
  project: Project;
  palette: Palette;
  /** File > New. */
  onNew(): void;
  /** File > Import image. */
  onImport(): void;
  /** Go to the library screen. */
  onLibrary(): void;
  /** Open one of the generated sample charts. */
  onSample(size: number): void;
  /** Open this chart in a new form (after converting it to another thread brand). */
  onReplace(project: Project): void;
}

/** The editor for one chart: menus, tools, the chart itself and its panels. */
export function ChartScreen({ project, palette, onNew, onImport, onLibrary, onSample, onReplace }: Props) {
  const { t, locale, setLocale } = useI18n();
  /** Which colour the picker is choosing: the drawing colour or the end of the gradient. */
  const [dialog, setDialog] = useState<'color' | 'gradientStart' | 'gradientEnd' | 'threads' | null>(null);
  const [info, setInfo] = useState<ViewInfo>({ scale: 1, cell: null, rect: { x: 0, y: 0, width: 0, height: 0 } });
  const defaults = useMemo(() => defaultColors(project.brand), [project.brand]);
  /** Palette index of the drawing colour. */
  const [selected, setSelected] = useState(defaults.draw);
  const [tool, setTool] = useState<ToolId>(DEFAULT_TOOL);
  const [stitch, setStitch] = useState<StitchId>('full');
  const [settings, setSettings] = useState<ToolSettings>({ brushSize: 1, brushShape: 'round', fillMode: 'solid' });
  const changeSettings = useCallback((patch: Partial<ToolSettings>) => setSettings((now) => ({ ...now, ...patch })), []);
  /** Palette indices the gradient bucket runs between. */
  const [gradientStart, setGradientStart] = useState(defaults.gradient[0]);
  const [gradientEnd, setGradientEnd] = useState(defaults.gradient[1]);
  const [layers, setLayers] = useState<Record<LayerId, LayerState>>({
    full: { visible: true, locked: false },
    fractional: { visible: true, locked: false },
    backstitch: { visible: true, locked: false },
  });
  const visible = useMemo(
    () => ({ full: layers.full.visible, fractional: layers.fractional.visible, backstitch: layers.backstitch.visible }),
    [layers],
  );
  const [notice, setNotice] = useState('');
  const view = useRef<GridViewHandle>(null);
  const panels = usePanels(PANELS);

  const { grid } = project;
  // Everything that changes the chart goes through its editor (tools, undo, selection).
  const editor = useMemo(() => createEditor(project.grid, palette.size, project), [project, palette]);
  const { counts } = editor;

  useEffect(() => editor.setBrush(settings.brushSize, settings.brushShape), [editor, settings.brushSize, settings.brushShape]);
  const ramp = useMemo(() => gradientRamp(palette, gradientStart, gradientEnd), [palette, gradientStart, gradientEnd]);

  // Charts from the library save themselves a moment after every change. Samples are not kept.
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const saver = useMemo(() => createAutosaver(() => saveProject(project, editor), setSaveState), [project, editor]);
  useEffect(() => {
    if (!project.id) return;
    const unsubscribe = editor.subscribe((change) => {
      if (change.cells === null || change.cells.length > 0 || change.fractions.length > 0 || change.backstitch) saver.touch();
    });
    // Closing the tab with unsaved changes: save, and let the browser ask before leaving.
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!saver.dirty) return;
      void saver.flush();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', onLeave);
      saver.dispose();
      void saver.flush(); // leaving this chart: whatever is pending goes to the library
    };
  }, [project, editor, saver]);

  // The grid is edited in place; `revision` tells React that what it shows of it is out of date.
  // Bumped at most once per frame, however many cells a stroke changes.
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  /** Cells edited since the last revision, for views that update incrementally. */
  const dirty = useRef<{ cells: number[]; all: boolean }>({ cells: [], all: false });
  useEffect(() => {
    let pending = 0;
    const unsubscribe = editor.subscribe((change) => {
      if (change.cells === null) dirty.current.all = true;
      else dirty.current.cells.push(...change.cells);
      pending ||= requestAnimationFrame(() => {
        pending = 0;
        bump();
      });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(pending);
    };
  }, [editor]);

  // The editor refuses to draw on locked layers. Locks belong to the window, so a new chart inherits them.
  useEffect(() => {
    for (const id of Object.keys(layers) as LayerId[]) editor.setLocked(id, layers[id].locked);
  }, [editor, layers]);

  // Runs after the panels' own effects, so they have seen the list before it is emptied.
  useEffect(() => {
    dirty.current = { cells: [], all: false };
  }, [revision, editor]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keyboard: single keys pick a tool (as in the toolbar tooltips); the rest are the Edit menu's shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const key = e.key.toLowerCase();
      // Typing in a field is not a shortcut, except letters in a number field (the brush size), which cannot be typed there anyway.
      const lettersOnly = target.matches('input[type=number]') && /^[a-z[\]]$/.test(key) && !e.ctrlKey && !e.metaKey;
      if (target.closest('input, select, textarea, dialog, [role=menubar]') && !lettersOnly) return;
      if (e.ctrlKey || e.metaKey) {
        if (key === 's') void saver.flush();
        else if (key === 'z' && !e.shiftKey) editor.undo();
        else if (key === 'y' || (key === 'z' && e.shiftKey)) editor.redo();
        else if (key === 'a') editor.selectAll();
        else return;
      } else if (e.altKey) {
        return;
      } else if (key === 'escape') {
        editor.deselect();
      } else if (key === 'delete' || key === 'backspace') {
        editor.eraseSelection();
      } else {
        if (key === '[' || key === ']') {
          setSettings((now) => ({ ...now, brushSize: Math.max(1, Math.min(MAX_BRUSH, now.brushSize + (key === ']' ? 1 : -1))) }));
          e.preventDefault();
          return;
        }
        const def = TOOLS.find((d) => d.key === key);
        const kind = STITCHES.find((d) => d.key === key);
        if (def) setTool(def.id);
        else if (kind) setStitch(kind.id);
        else return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, saver]);

  useEffect(() => {
    document.title = `${project.name} · Crossing`;
  }, [project.name]);

  const navigate = useCallback((x: number, y: number) => view.current?.centerOn(x, y), []);

  const changeLayer = useCallback((id: LayerId, state: LayerState) => setLayers((all) => ({ ...all, [id]: state })), []);
  // Clicking a layer picks a stitch type that draws on it (keeping the current one if it already does).
  const activateLayer = useCallback(
    (id: LayerId) => setStitch((now) => (LAYER_OF[now] === id ? now : STITCHES.find((s) => LAYER_OF[s.id] === id)!.id)),
    [],
  );
  const onBlocked = useCallback((id: LayerId) => setNotice(t.layersPanel.blocked(t.layers[id])), [t]);

  const panelContent: Record<string, ReactNode> = {
    colors: <ColorsPanel palette={palette} counts={counts} extras={editor.extras} revision={revision} selected={selected} onSelect={setSelected} />,
    layers: <LayersPanel layers={layers} active={LAYER_OF[stitch]} onChange={changeLayer} onActivate={activateLayer} />,
    preview: <PreviewPanel grid={grid} palette={palette} revision={revision} dirty={dirty} viewRect={info.rect} onNavigate={navigate} />,
  };

  // Items without onSelect are placeholders for features that do not exist yet.
  const m = t.menu;
  const menus: Menu[] = [
    {
      label: m.file,
      items: [
        { label: m.new, onSelect: onNew },
        // The library must show this chart as it is now, so the pending save finishes first.
        { label: m.library, onSelect: () => void saver.flush().then(onLibrary) },
        ...(project.id ? [{ label: m.save, shortcut: 'Ctrl+S', onSelect: () => void saver.flush() }] : []),
        'separator',
        { label: m.importImage, onSelect: onImport },
        { label: m.exportPdf, shortcut: 'Ctrl+E' },
        'separator',
        ...SAMPLE_SIZES.map((s) => ({
          label: m.sampleChart(s),
          checked: project.sampleSize === s,
          onSelect: () => onSample(s),
        })),
      ],
    },
    {
      label: m.edit,
      items: [
        { label: m.undo, shortcut: 'Ctrl+Z', onSelect: () => editor.undo() },
        { label: m.redo, shortcut: 'Ctrl+Y', onSelect: () => editor.redo() },
        'separator',
        { label: m.cut, shortcut: 'Ctrl+X' },
        { label: m.copy, shortcut: 'Ctrl+C' },
        { label: m.paste, shortcut: 'Ctrl+V' },
        'separator',
        { label: m.selectAll, shortcut: 'Ctrl+A', onSelect: () => editor.selectAll() },
        { label: m.deselect, shortcut: 'Esc', onSelect: () => editor.deselect() },
        { label: m.eraseSelection, shortcut: 'Del', onSelect: () => editor.eraseSelection() },
        'separator',
        { label: m.preferences },
      ],
    },
    {
      label: m.view,
      items: [
        { label: m.zoomIn, shortcut: '+', onSelect: () => view.current?.zoomBy(ZOOM_STEP) },
        { label: m.zoomOut, shortcut: '−', onSelect: () => view.current?.zoomBy(1 / ZOOM_STEP) },
        { label: m.fit, shortcut: '0', onSelect: () => view.current?.fit() },
        'separator',
        { label: m.showGrid },
        { label: m.showSymbols },
        'separator',
        ...Object.entries(LOCALES).map(([id, messages]) => ({ label: messages.languageName, checked: locale === id, onSelect: () => setLocale(id) })),
      ],
    },
    {
      label: m.chart,
      items: [{ label: m.chartSize }, { label: m.replaceColor }, { label: m.threadPalette, onSelect: () => setDialog('threads') }],
    },
    {
      label: m.window,
      items: [
        ...PANELS.map((def) => {
          const open = panels.isOpen(def.id);
          return {
            label: t.panels[def.id] ?? def.id,
            checked: open,
            onSelect: () => {
              panels.patch(def.id, { open: !open });
              panels.bringToFront(def.id);
            },
          };
        }),
        'separator' as const,
        { label: m.resetLayout, onSelect: panels.reset },
      ],
    },
    {
      label: m.help,
      items: [{ label: m.shortcuts }, { label: m.about }],
    },
  ];

  const unavailable = (what: string) => setNotice(m.unavailable(what));
  const current = palette.entries[selected];
  const entry = info.cell && palette.entries[grid.cells[info.cell.y * grid.width + info.cell.x]];

  return (
    <div className="app">
      <MenuBar menus={menus} onUnavailable={unavailable} />
      <Toolbar tool={tool} onTool={setTool} stitch={stitch} onStitch={setStitch} onUndo={editor.canUndo ? () => editor.undo() : undefined} onRedo={editor.canRedo ? () => editor.redo() : undefined}>
        <ToolOptions
          tool={tool}
          settings={settings}
          onChange={changeSettings}
          gradient={{ start: palette.entries[gradientStart], end: palette.entries[gradientEnd] }}
          onPickGradient={(which) => setDialog(which === 'start' ? 'gradientStart' : 'gradientEnd')}
        />
        <button type="button" className="current-color" title={t.toolbar.currentColor} onClick={() => setDialog('color')}>
          <i className="swatch" style={{ background: `rgb(${current.rgb.join(',')})` }} />
          <span>{`${current.brand} ${current.code} · ${current.name}`}</span>
        </button>
      </Toolbar>
      <Workspace defs={PANELS} panels={panels} titles={t.panels} content={panelContent}>
        <GridView
          ref={view}
          editor={editor}
          palette={palette}
          tool={tool}
          stitch={stitch}
          color={selected}
          visible={visible}
          brushSize={settings.brushSize}
          brushShape={settings.brushShape}
          fillMode={settings.fillMode}
          ramp={ramp}
          onView={setInfo}
          onBlocked={onBlocked}
          onPick={(index) => index !== 0 && setSelected(index)}
        />
      </Workspace>
      <footer className="status">
        <span>{t.status.size(project.name, grid.width, grid.height)}</span>
        <span className={`save-state ${project.id ? saveState : 'temporary'}`}>{project.id ? t.saveState[saveState] : t.saveState.temporary}</span>
        <span className="status-cell" role="status">
          {notice ? (
            notice
          ) : info.cell && entry ? (
            <>
              {t.status.cell(info.cell.x + 1, info.cell.y + 1)}
              {entry.id !== 0 && (
                <>
                  {' · '}
                  <i className="swatch" style={{ background: `rgb(${entry.rgb.join(',')})` }} />
                  {entry.symbol} {entry.brand} {entry.code}
                </>
              )}
            </>
          ) : (
            t.status.hint
          )}
        </span>
        <span className="status-zoom">
          <button type="button" onClick={() => view.current?.zoomBy(1 / ZOOM_STEP)} aria-label={t.status.zoomOut} title={`${t.status.zoomOut} (−)`}>
            −
          </button>
          <output className="zoom" title={t.status.pixelsPerStitch}>
            {info.scale < 10 ? info.scale.toFixed(1) : Math.round(info.scale)} px
          </output>
          <button type="button" onClick={() => view.current?.zoomBy(ZOOM_STEP)} aria-label={t.status.zoomIn} title={`${t.status.zoomIn} (+)`}>
            +
          </button>
          <button type="button" onClick={() => view.current?.fit()} title={`${t.status.fitTitle} (0)`}>
            {t.status.fit}
          </button>
        </span>
      </footer>
      {dialog === 'threads' && (
        <ThreadsDialog
          brand={project.brand}
          onConvert={(brand) => {
            setDialog(null);
            // Finish any pending save first: a save of the old version landing after the
            // converted chart is stored would overwrite it.
            void saver.flush().then(() => onReplace(convertProject(project, editor, brand)));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && dialog !== 'threads' && (
        <ColorPickerDialog
          palette={palette}
          selected={dialog === 'color' ? selected : dialog === 'gradientStart' ? gradientStart : gradientEnd}
          onPick={(id) => {
            if (dialog === 'color') setSelected(id);
            else if (dialog === 'gradientStart') setGradientStart(id);
            else setGradientEnd(id);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
