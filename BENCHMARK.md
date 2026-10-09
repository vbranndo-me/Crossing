# Cross Stitch Tool: Performance Benchmark (Phase 1)

> Task spec for Claude Code. Goal: kill performance risk early, before building the real editor.

## 1. Context

We are building a cross stitch design tool (online PWA + desktop via Tauri), a robust alternative to WinStitch. A pattern is a grid of cells (color + symbol). Typical charts are around 200x200 (40k cells), but **1000x1000 (1M cells) is a hard product requirement**, not a stress test. The tool must stay fluid at that size, on both web and desktop. 500x500 (250k) is the intermediate checkpoint. Any strategy that cannot meet the 1000x1000 targets is rejected, even if it wins at smaller sizes.

Core features that stress performance:

1. Rendering and interaction (pan, zoom, paint) on a large grid
2. Image to pattern conversion (color quantization + palette matching with CIEDE2000)
3. Undo/redo on large edits
4. PDF export of a paginated chart with symbols and legend

This benchmark is a throwaway prototype. Do **not** build the real UI. Build only what is needed to measure.

## 2. Stack

- TypeScript (strict), Vite
- Vitest for core/unit benchmarks (Node)
- Playwright (Chromium) for browser benchmarks (FPS, frame time, memory)
- `pdf-lib` for PDF generation
- Web Workers for conversion and PDF
- No UI framework. Plain canvas + a minimal HTML harness per benchmark.

## 3. Repo layout

```
cross-stitch-bench/
  package.json
  BENCHMARK.md            <- this file
  src/
    core/
      grid.ts             <- Uint16Array-based grid model
      history.ts          <- diff-based undo/redo
      color.ts            <- sRGB -> Lab, CIEDE2000
      palette.ts          <- palette types + synthetic palette generator
      convert.ts          <- image -> grid pipeline
      pdf.ts              <- paginated PDF export
    bench/
      render/             <- B1 harness (html + ts)
      history/            <- B2
      convert/            <- B3
      pdf/                <- B4
  fixtures/
    images/               <- test images (see section 5)
  results/
    raw/                  <- JSON per run
    REPORT.md             <- generated summary
  scripts/
    run-all.ts
    make-report.ts
```

## 4. Data model (use this in all benchmarks)

- Grid: `{ width, height, cells: Uint16Array }`, where each value is an index into a palette table (0 = empty).
- Palette entry: `{ id, brand, code, name, rgb: [r,g,b], lab: [l,a,b], symbol: string }`.
- Undo/redo stores **diffs** (`{ index, prev, next }[]` per action), never full snapshots.

## 5. Test data

Grid sizes (all benchmarks): **200x200, 500x500, 1000x1000**.

Synthetic palette: generate ~500 colors with a seeded RNG (stand-in for DMC + Anchor). Also test with 60 and 1000 colors to see sensitivity. Pre-compute Lab for every entry.

Images in `fixtures/images/` (generate synthetically if no real photo is available, and document which are which):

- `gradient.png` (smooth gradient)
- `noise.png` (high-entropy noise, worst case for caching)
- `flat.png` (few flat colors, best case)
- `photo-*.jpg` (any real photos the user drops in; benchmark must pick them up automatically if present)

## 6. Benchmarks

### B1. Rendering and interaction (browser)

Compare three strategies, same harness, switchable by query param:

- **S1 naive**: redraw the full grid every frame, fillRect per cell, symbol per cell.
- **S2 culled + cached**: viewport culling, grid base layer cached in an offscreen canvas, symbols only when cell size >= 12 px, dirty-rect repaint on edits.
- **S3 WebGL** (mandatory to implement and measure, since 1000x1000 is a requirement): store the grid as a texture (one texel per cell, palette index) and render with a fragment shader, or instanced quads. Symbols via a texture atlas. Compare against S2 at every size.

Because 1M cells must be fluid, also measure at 1000x1000: memory of the render layers, time to first frame after opening a project, and cost of a full-grid operation (e.g. replace color X with Y across the whole chart) followed by repaint.

Scenarios (scripted, deterministic):

- Zoom levels: 2, 8, 16, 32 px per cell
- Pan: 5 s continuous scripted drag across the grid
- Zoom: 5 s continuous zoom in/out
- Paint: 500 pencil strokes via dispatched pointer events; measure pointer event to next paint latency

Metrics: frame time p50 / p95 / p99, dropped frames (>20 ms), average FPS, JS heap used (`performance.memory` or CDP), paint latency p95.

### B2. Data model and history (Node)

- Create grids at all sizes, report memory (bytes) of `cells`.
- Apply 10k random edits (single cells), then 100 large edits (flood fill of up to 50% of grid), record time per op.
- Undo all, redo all. Measure total time and history memory.
- Compare diff-based history vs full-snapshot history to prove the point (snapshot is the baseline).

### B3. Image to pattern conversion

Pipeline: load image, resize to grid size, convert to Lab, reduce colors (k-means or median cut, pick one and note which), map each pixel to nearest palette entry using CIEDE2000, optional dithering (Floyd-Steinberg) as a flag.

Variants to compare:

- V1 naive: CIEDE2000 against every palette entry per pixel
- V2 with color cache (Map from quantized input color to output index)
- V3 pre-quantize to N colors first (N = 16, 32, 64), then map only those N
- V4 V3 running in a **Web Worker** (measure main-thread blocking time, should be ~0)

Run for every grid size x palette size x image fixture. Metrics: total time, time per stage (resize, Lab, quantize, map, dither), main-thread long tasks (>50 ms), output quality sanity check (mean deltaE between source and result, so speedups are not silently destroying quality).

### B4. PDF export

- Generate a paginated chart: e.g. 50x50 cells per page, centered grid lines, bold line every 10 cells, symbols in each cell, page margins, page header with coordinates.
- Add a legend page (code, name, symbol, stitch count, estimated skeins).
- Add a cover page with a raster preview.
- Symbols must be vector (embedded font glyphs or reusable paths), not 40k separate objects with unique resources.
- Run in a Worker, report progress events.

Metrics: total time, peak memory, output file size, page count, time to first page, for each grid size.

## 7. Targets (pass/fail)

| Area | 200x200 | 500x500 | 1000x1000 (required) |
|---|---|---|---|
| Pan/zoom (p95 frame time) | <= 16.7 ms | <= 16.7 ms | <= 16.7 ms |
| Paint latency p95 | <= 50 ms | <= 50 ms | <= 50 ms |
| Whole-grid operation + repaint | <= 100 ms | <= 200 ms | <= 500 ms |
| Time to first frame on open | <= 300 ms | <= 500 ms | <= 1 s |
| Conversion (end to end, worker) | <= 2 s | <= 5 s | <= 10 s |
| Main thread blocked during conversion | < 50 ms | < 50 ms | < 50 ms |
| PDF export | <= 5 s | <= 15 s | <= 45 s |
| PDF peak memory | <= 200 MB | <= 400 MB | <= 800 MB |
| Grid memory | trivial | trivial | <= 2 MB |

The 1000x1000 column is a hard gate. If it is missed:

1. Record the number and the likely cause.
2. Escalate in this order: S2 to S3 (WebGL) for rendering; Worker typed arrays to WASM/Rust for conversion; streaming/chunked generation for PDF.
3. Re-measure after each escalation. Do not tune a failing approach forever.
4. If the target still cannot be met, report the best achieved numbers and propose a product-level fallback (e.g. simplified rendering while panning, progressive conversion, split PDF into volumes).

## 8. Deliverables

1. Working harnesses for B1 to B4, runnable with `npm run bench:render|history|convert|pdf` and `npm run bench:all`.
2. Raw JSON results in `results/raw/` (include machine info: CPU, RAM, browser version, OS).
3. `results/REPORT.md` generated by `scripts/make-report.ts`, containing:
   - Table of results vs targets (pass/fail)
   - Which strategies and variants won, with the numbers
   - Top 3 bottlenecks found
   - Recommendation: what to adopt for the real app, and what needs a deeper look
   - Open questions

## 9. Working rules

- Keep the code small and honest. Benchmarks must be reproducible (seeded RNG, fixed viewport size, headless Chromium with fixed flags).
- Warm up before measuring, then take at least 5 runs and report median and spread.
- Do not optimize prematurely: implement the naive version first so we have a baseline.
- Commit per benchmark (B1, B2, B3, B4, report) with a short message.
- If something in this spec is ambiguous, pick the most reasonable option, write the decision at the top of `results/REPORT.md` under "Assumptions", and keep going.

## 10. Out of scope

Real editor UI, real DMC/Anchor data, backstitch/half stitches, file formats, accounts/sync, Tauri packaging.

## 11. Open questions (fill in during the work)

- [ ] Is k-means or median cut better for quality vs speed?
- [ ] At what cell size do symbols become worth drawing?
- [ ] Does S2 (canvas 2D) meet the 1000x1000 targets, or is WebGL (S3) the default?
- [ ] Does WASM/Rust for conversion pay off vs a Worker with typed arrays at 1000x1000?
- [ ] Does the Tauri webview (WebKit on macOS/Linux, WebView2 on Windows) match Chromium results? Re-run B1 there once a Tauri shell exists.
- [ ] Is a 1000x1000 PDF (hundreds of pages) usable, or should export offer page ranges / volumes?
- [ ] Anything else discovered during the work
