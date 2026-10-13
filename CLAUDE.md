# Crossing

A cross-stitch chart designer (an alternative to WinStitch): a web app now, a Tauri desktop app later.
Charts of up to 1000 × 1000 stitches are a hard requirement. The owner writes in Portuguese (pt-BR):
reply in Portuguese. Code, comments and commit messages are in English.

## Layout

- `app/` is the product: Vite + React 19 + TypeScript (strict) + Vitest. Everything below refers to it.
- The repository root holds the phase 1 performance benchmark (`BENCHMARK.md`, `src/`, `scripts/`,
  `results/REPORT.md`). It is finished; it is what justified WebGL and the 1000 × 1000 limit.
- There is no backend. Everything runs in the browser: the library is IndexedDB, image conversion
  runs in a Web Worker.

## Commands (in `app/`)

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # vitest
npm run typecheck
npm run build
npm run publish    # tests, build, push the build to gh-pages
```

The app is published at https://vbranndo-me.github.io/Crossing/ from the `gh-pages` branch, which
holds only the latest build. `npm run publish` (in `app/`) runs the tests, builds and replaces that
branch. It is not automatic: publish when the owner asks, or after a change they will want to try.

## How the app is put together (`app/src`)

- `App.tsx`: shell. Shows `LibraryScreen` or `ChartScreen` (the editor), plus the new-chart and
  import dialogs.
- `core/`: `grid.ts` (a chart is a `Uint16Array` of palette indices, 0 = empty), `palette.ts`, `color.ts`
  (sRGB ↔ Lab, CIEDE2000).
- `edit/editor.ts`: `createEditor` owns the chart while it is open: the three fixed layers (full
  stitches; half and quarter stitches; backstitch lines, where a line of no length is a French knot),
  per-colour counts, selection, undo / redo. Every edit goes through it and it emits a `Change` that
  the renderer and the panels follow. `history.ts` is the undo stack (actions with `undo` / `redo`).
- `render/webgl.ts`: WebGL2 renderer (grid as an R16UI texture, palette texture, glyph atlas, fraction
  textures, a second program for backstitch). `render/flat.ts`: one-pixel-per-stitch picture of all
  layers, used by the preview panel and the library thumbnail.
- `view/GridView.tsx`: canvas, camera and all pointer input (which tool does what on press / drag / release).
- `tools.ts`: the tool and stitch-type registries. `ui/`: menu bar, toolbar, tool options, dockable
  panels (`Workspace`, `panels.ts`), `Dialog`, pixel icons (`icons.tsx`, 16 × 16 text bitmaps).
- `panels/`: colours, preview, layers. `dialogs/`: new chart, colour picker, threads (brand), chart
  size, replace colour, text, and the image import wizard.
- `convert/`: image → chart. `pipeline.ts` is a chain of stages, each one a function with its own
  settings: `size` (resampling in `resample.ts`, or PixelOE in `pixeloe.ts`) → `adjust` → `simplify`
  (reduce to a few flat RGB colours, with an editable palette and a colour-count analysis) → `colors`
  (choose threads, optional dithering) → `cleanup` (confetti, rare colours). `worker.ts` /
  `converter.ts` run it off the main thread; `dialogs/ImportImageDialog.tsx` is the wizard, one step per stage.
- `threads/brands.ts`: DMC and Anchor tables parsed from `threads/data/*.csv`. Charts are saved with
  thread codes, so indices survive changes to the tables.
- `storage/`: `library.ts` (IndexedDB), `autosave.ts`, `thumbnail.ts`. `project.ts`: the `Project`
  type and open / save / convert brand / resize.
- `i18n/`: `pt-BR.ts` is the reference dictionary and defines the `Messages` type; `en.ts` must match
  it. Every user-facing string goes in both.
- `theme.css` holds the design tokens (CSS variables), `styles.css` the components. The look is
  Aseprite-like and provisional: keep it driven by the tokens, pixel fonts come later.

## Conventions

- Match the surrounding code: small modules, doc comments that say what a thing is for, no new
  dependencies without asking (the app has only React).
- Logic that can be tested without a browser lives outside components and has a `*.test.ts` beside it.
- Run `npm test` and `npm run typecheck` before committing. Commit only when asked.
- Work is done step by step with the owner: when they ask for options or suggestions, propose and
  wait; when they say to implement, implement.

## Known gaps (October 2026)

Agreed priorities, in order: symbols on the chart, a stitching / viewing mode, PDF export, a file
format of its own.

- **Stitching mode** (wanted by the owner, who stitches from the screen rather than from a printout):
  highlight one or more colours from the list or by clicking a stitch, mark stitches as done with
  per-colour progress, 10 × 10 grid with numbering, symbols, remembered position. Proposed, not started.
  Open questions for the owner: computer or tablet (touch), and marking stitch by stitch or by area.
- No PDF export, no symbols toggle, no file export / import (charts live only in the browser), no PNG export.
- Selection operations (move, copy, paste, flip, rotate) act on full stitches only.
- Undo history is lost when a chart is closed; resizing or cropping a chart also clears it.
- Text tool rasterises system fonts: unreadable under about 10 stitches tall. Needs built-in pixel fonts.
- Import wizard: dithering still sits in the threads step (little effect after simplifying); PixelOE is
  slow on large charts and has no progress bar; no correction brush; only tested with synthetic images.
- Anchor table has wrong names (e.g. 925 is an orange, its name was copied from 924): the owner said to
  leave it for now. RGB values of both tables are third-party approximations of unknown licence.
- Menu items without `onSelect` in `ChartScreen.tsx` are placeholders (preferences, show grid, show
  symbols, shortcuts, about, export PDF).
- Desktop (Tauri), licensing, code signing, PWA install / offline: not started, explicitly "for later".
- Never tested on a weak machine, a tablet or a phone.
