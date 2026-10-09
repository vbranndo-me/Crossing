# Cross Stitch Tool: Performance Benchmark Report (Phase 1)

Generated 2026-10-09 02:24 UTC by `scripts/make-report.ts` from `results/raw/*.json`. Spec: [BENCHMARK.md](../BENCHMARK.md).

## Machine
| CPU | Cores | RAM | OS | Node | Browser | GPU |
|---|---|---|---|---|---|---|
| Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz | 12 | 31.9 GB | Windows_NT 10.0.26200 x64 | v24.17.0 | Chromium 156.0.8078.4 (headless) | ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11) |

## Assumptions
Decisions taken where the spec left room. Each one is a place where a different reasonable choice would move the numbers.

**General**

- The repo root is the folder that already held `BENCHMARK.md`. Scripts are TypeScript run directly by Node 24 (type stripping), so there is no build step for them. The browser harnesses are a Vite production build served by `vite preview`.
- "5 runs" means 5 measured runs after a warm-up, reported as median with min and max. Exceptions are listed below and marked in the tables.
- The test machine has a fast discrete GPU. Two extra B1 runs approximate a machine without one (WebGL on the CPU, canvas 2D on the CPU).
- No real photo was available: all three image fixtures are synthetic (`fixtures/images/README.md`). `photo-*.jpg` files dropped there are picked up automatically.

**B1 render**

- Chromium runs headless with `--disable-gpu-vsync --disable-frame-rate-limit`. Frame time is the interval between animation frames, which with those flags is the real cost of producing a frame rather than a multiple of 16.7 ms. "Dropped" means longer than 20 ms. Average FPS is therefore uncapped FPS.
- Paint latency: each pointer event is dispatched at the start of a frame and repainted in the same frame, as Chromium does with real rAF-aligned input. Latency runs from the dispatch until the next frame begins. On a 60 Hz display the photons arrive up to one refresh (16.7 ms) later; that wait is not in the number.
- A stroke is pointerdown, 3 pointermoves, pointerup: 500 strokes give 2000 latency samples. The paint scenario stops after 8 s if a strategy cannot finish.
- Time to first frame: the grid and palette are already in memory (file parsing is out of scope). The clock covers building the renderer (context, layers, textures, symbol atlas, shaders) and presenting a fit-to-view frame. Every run is a fresh page, after one throwaway page load per strategy and size.
- Whole-grid operation: swap two colours across the whole chart, then repaint at fit-to-view, 5 times per run.
- Pan is one corner-to-corner drag and back in 5 s. Zoom is two 2 px to 32 px cycles in 5 s around the centre. A 12 px pan was added to the four zoom levels of the spec because it is the worst case for symbols (smallest size at which they are drawn). It is reported but not counted in the pass/fail row.
- All strategies draw symbols from 12 px per cell and grid lines from 4 px, except S1, which draws a rectangle and a symbol for every cell at every size, as specified.
- S1 on 500x500 and 1000x1000 was run once: a frame takes hundreds of milliseconds to seconds, so repetition adds nothing.
- The chart is synthetic: smooth regions in 48 colours plus 5% speckle using all 500 palette colours. Symbols are about 1000 distinct Unicode characters (ASCII, Latin-1, Greek, dingbats, arrows, math, shapes) drawn with the system font.

**B2 history**

- Runs under Vitest in a forked Node process with `--expose-gc`. History memory is the measured growth of JS heap + ArrayBuffers after a forced GC.
- Three histories were compared: typed-array diffs ("packed"), the literal `{ index, prev, next }[]` of the spec ("object"), and full snapshots.
- A flood fill is capped at 50% of the grid. On a grid that starts empty, most fills hit that cap.
- The snapshot baseline gets fewer single edits (enough to fill about 400 MB) because 10,000 snapshots of a 2 MB grid do not fit in memory. Its per-action numbers are comparable; its totals are not.

**B3 convert**

- All variants run in Chromium, V1 to V3 on the main thread and V4 in a Web Worker created once at page load.
- Colour reduction is **median cut** over a 15-bit colour histogram. k-means (8 Lloyd iterations seeded by median cut) is measured as an extra variant to answer the open question.
- V2's cache is keyed by the input colour quantized to 15 bits (5 bits per channel), held in a typed array rather than a `Map`.
- V1 is measured once with no warm-up. Above 1e8 CIEDE2000 calls (pixels x palette size) it converts a row sample and the map stage is scaled up; those cells are marked.
- Dithering is measured on V3 and V4 only. With dithering on, mapping happens inside the error-diffusion pass, so its time is reported under "dither" and "map" covers only the palette lookup of the reduced colours.
- Mean deltaE is per pixel against the source. Dithering trades per-pixel error for better average colour, so its deltaE is higher by construction and is not a quality regression by itself.
- The synthetic palette is random RGB, which is sparser than a real thread catalogue, so absolute deltaE values are high. Only differences between variants mean something.
- `noise.png` is only real noise at 1000x1000. Downscaling to 500 or 200 averages it towards grey.
- Times exclude the deltaE quality check, which runs after each conversion on the same thread. For the main-thread variants that check is what the "longest main-thread task" column mostly shows (about 0.6 s at 1000x1000), so read that column only for V4.
- The warm-up run is reported as the "cold first run". Later runs reuse the decoded image, so their resize stage is mostly the downscale.
- The pass/fail row uses V4 with n = 64, the most expensive worker variant without dithering.

**B4 PDF**

- Timing and memory come from Node: each run is a fresh process that exports inside a `worker_threads` worker, which makes peak memory measurable (`process.resourceUsage().maxRSS`). The same code is also run in a Web Worker in Chromium for time and main-thread blocking.
- Peak memory in the pass/fail row is the peak RSS of that whole process, Node runtime included. It is the conservative reading.
- Layout: A4 portrait, 50x50 cells per page at 10 pt per cell, every cell filled with its colour and carrying its symbol, thin grid lines, bold line every 10 cells, coordinates in the header and along the axes. One cover page with a raster preview, then the chart pages, then the legend.
- Vector symbols use the three symbol-capable standard PDF fonts (Helvetica, ZapfDingbats, Symbol): nothing is embedded and each page references the same three font resources. Palette symbols that those fonts do not have are replaced by an ASCII character. A real symbol font would be embedded once and would cost roughly its file size.
- Skeins are estimated at 1600 full cross stitches per skein.
- "naive" uses pdf-lib's `drawRectangle` / `drawText` / `drawLine` per cell. "stream" writes one compressed content stream per page by hand. The worker heap is limited to 4 GB and a run is abandoned after 240 s.

## Results vs targets

Each cell is the median of the runs for the worst case of that area (worst zoom level, worst image and palette). Details and spread are in the sections below.

| Area | Strategy | 200x200 | 500x500 | 1000x1000 (required) |
|---|---|---|---|---|
| Pan/zoom p95 frame time (<= 16.7 ms) | S2 canvas culled + cached | 10.3 ms PASS | 10.6 ms PASS | 10.7 ms PASS |
| Pan/zoom p95 frame time (<= 16.7 ms) | S3 WebGL | 0.80 ms PASS | 0.70 ms PASS | 0.80 ms PASS |
| Pan/zoom p95 frame time (<= 16.7 ms) | S1 naive canvas | 255 ms **FAIL** | 953 ms **FAIL** | 3521 ms **FAIL** |
| Paint latency p95 (<= 50 ms) | S2 canvas culled + cached | 0.90 ms PASS | 0.90 ms PASS | 0.90 ms PASS |
| Paint latency p95 (<= 50 ms) | S3 WebGL | 0.80 ms PASS | 0.70 ms PASS | 0.80 ms PASS |
| Paint latency p95 (<= 50 ms) | S1 naive canvas | 208 ms **FAIL** | 879 ms **FAIL** | 1699 ms **FAIL** |
| Whole-grid operation + repaint (<= 100 / 200 / 500 ms) | S2 canvas culled + cached | 1.30 ms PASS | 2.60 ms PASS | 5.80 ms PASS |
| Whole-grid operation + repaint (<= 100 / 200 / 500 ms) | S3 WebGL | 1.20 ms PASS | 1.70 ms PASS | 3.00 ms PASS |
| Whole-grid operation + repaint (<= 100 / 200 / 500 ms) | S1 naive canvas | 258 ms **FAIL** | 3124 ms **FAIL** | 15477 ms **FAIL** |
| Time to first frame on open (<= 300 / 500 / 1000 ms) | S2 canvas culled + cached | 5.80 ms PASS | 7.00 ms PASS | 9.20 ms PASS |
| Time to first frame on open (<= 300 / 500 / 1000 ms) | S3 WebGL | 144 ms PASS | 138 ms PASS | 136 ms PASS |
| Time to first frame on open (<= 300 / 500 / 1000 ms) | S1 naive canvas | 218 ms PASS | 3491 ms **FAIL** | 15601 ms **FAIL** |
| Conversion end to end, worker (<= 2 / 5 / 10 s) | v4 worker n=64 | 0.03 s PASS | 0.05 s PASS | 0.06 s PASS |
| Main thread blocked during conversion (< 50 ms) | v4 worker n=64 | 0.00 ms PASS | 0.00 ms PASS | 0.00 ms PASS |
| PDF export (<= 5 / 15 / 45 s) | pdf stream | 0.34 s PASS | 1.18 s PASS | 4.26 s PASS |
| PDF peak memory (<= 200 / 400 / 800 MB) | pdf stream, process peak RSS | 131 MB PASS | 147 MB PASS | 196 MB PASS |
| PDF export (<= 5 / 15 / 45 s) | pdf naive | 2.44 s PASS | 15.00 s PASS | n/a |
| PDF peak memory (<= 200 / 400 / 800 MB) | pdf naive, process peak RSS | 475 MB **FAIL** | 1722 MB **FAIL** | n/a |
| Grid memory (trivial / trivial / <= 2 MB) | Uint16Array | 0.08 MB PASS | 0.48 MB PASS | 1.91 MB PASS |

- `pdf naive` at 1000x1000 did not finish: Worker terminated due to reaching memory limit: JS heap out of memory.

## B1. Rendering and interaction

Viewport 1280x720, 500-colour palette, 5 runs per row (fresh page each), median shown. Frame time is the interval between animation frames with vsync and the frame-rate limit disabled, so it is the real cost of a frame. S1 on 500x500 and 1000x1000 was run once.

| Strategy | Grid | First frame ms | Pan p95 ms at 2 / 8 / 12 / 16 / 32 px | Zoom p95 ms | Zoom p99 ms | Lowest avg FPS | Most dropped frames (> 20 ms) per scenario | Paint p95 ms at 2 / 8 / 16 / 32 px | Replace colour + repaint ms | Render layers MB | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 naive canvas | 200 | 218 | 223 / 81.1 / 55.9 / 47.8 / 51.8 | 255 | 461 | 7 | 126 | 208 / 76.2 / 52.6 / 49.7 | 258 | 0.0 | 1.7 |
| S1 naive canvas | 500 | 3491 | 860 / 255 / 258 / 242 / 289 | 953 | 1134 | 1 | 23 | 879 / 262 / 241 / 243 | 3124 | 0.0 | 2.0 |
| S1 naive canvas | 1000 | 15601 | 3521 / 912 / 857 / 926 / 940 | 2379 | 2382 | 0 | 6 | 1699 / 906 / 890 / 884 | 15477 | 0.0 | 3.5 |
| S2 canvas culled + cached | 200 | 5.80 | 0.70 / 0.70 / 16.9 / 10.3 / 3.40 | 0.60 | 5.90 | 122 | 9 | 0.80 / 0.80 / 0.90 / 0.90 | 1.30 | 0.3 | 2.1 |
| S2 canvas culled + cached | 500 | 7.00 | 0.70 / 0.70 / 17.0 / 10.6 / 3.40 | 0.70 | 6.40 | 120 | 7 | 0.80 / 0.80 / 0.90 / 0.90 | 2.60 | 1.9 | 3.3 |
| S2 canvas culled + cached | 1000 | 9.20 | 0.70 / 0.80 / 17.3 / 10.7 / 3.50 | 0.70 | 6.17 | 120 | 6 | 0.70 / 0.80 / 0.90 / 0.90 | 5.80 | 7.6 | 7.6 |
| S3 WebGL | 200 | 144 | 0.80 / 0.70 / 0.70 / 0.70 / 0.70 | 0.70 | 1.00 | 2235 | 0 | 0.80 / 0.80 / 0.70 / 0.80 | 1.20 | 2.8 | 2.0 |
| S3 WebGL | 500 | 138 | 0.60 / 0.70 / 0.70 / 0.70 / 0.70 | 0.70 | 1.00 | 2387 | 0 | 0.70 / 0.70 / 0.70 / 0.70 | 1.70 | 3.2 | 2.4 |
| S3 WebGL | 1000 | 136 | 0.70 / 0.70 / 0.80 / 0.70 / 0.70 | 0.80 | 1.20 | 2246 | 0 | 0.80 / 0.80 / 0.70 / 0.80 | 3.00 | 4.7 | 3.8 |

Spread across runs for the 1000x1000 grid, median (min to max), ms:

| Strategy | First frame | Pan p95 at 12 px | Pan p95 at 16 px | Zoom p95 | Paint p95 at 16 px | Replace + repaint |
|---|---|---|---|---|---|---|
| S2 canvas culled + cached | 9.20 (8.60 to 10.6) | 17.3 (15.9 to 19.5) | 10.7 (10.5 to 10.9) | 0.70 (0.60 to 0.70) | 0.90 (0.80 to 1.00) | 5.80 (5.60 to 7.00) |
| S3 WebGL | 136 (133 to 156) | 0.80 (0.70 to 0.80) | 0.70 (0.70 to 0.70) | 0.80 (0.70 to 0.80) | 0.70 (0.70 to 0.90) | 3.00 (2.50 to 3.20) |

### Without a usable GPU (1000x1000 only)

| Setup | First frame ms | Pan p95 ms at 2 / 8 / 12 / 16 / 32 px | Zoom p95 ms | Paint p95 ms at 2 / 8 / 16 / 32 px | Replace + repaint ms |
|---|---|---|---|---|---|
| S3 WebGL on the CPU (SwiftShader) | 277 | 8.07 / 6.50 / 78.8 / 84.4 / 68.0 | 72.7 | 99.7 / 103 / 8.70 / 7.21 | 9.50 |
| S2 canvas 2D on the CPU (--disable-gpu) | 12.5 | 2.60 / 3.70 / 16.7 / 11.3 / 5.70 | 8.20 | 1.20 / 1.10 / 1.10 / 1.20 | 6.90 |

## B2. Data model and history

10000 single-cell edits, then 100 flood fills capped at 50% of the grid, then undo all and redo all. 5 runs, median. "packed" stores runs + values in typed arrays, "object" is the literal `{ index, prev, next }[]` from the spec, "snapshot" copies the whole grid per action (baseline; it gets fewer single edits so it fits in memory).

| Grid | cells | History | Actions | Single edit us | Flood fill ms (avg / p95) | Avg cells per fill | Undo all ms | Redo all ms | History memory (measured) | Per action |
|---|---|---|---|---|---|---|---|---|---|---|
| 200x200 | 0.08 MB | packed | 10100 | 0.39 | 0.37 / 0.80 | 11862 | 12.4 (11.6 to 13.1) | 11.8 (11.0 to 13.7) | 4.68 MB | 0.5 KB |
| 200x200 | 0.08 MB | object | 10100 | 0.53 | 0.47 / 1.03 | 11862 | 10.7 (10.2 to 11.6) | 6.67 (6.49 to 9.56) | 65 MB | 6.5 KB |
| 200x200 | 0.08 MB | snapshot | 5342 | 36.84 | 0.31 / 0.54 | 14743 | 34.3 (33.3 to 39.4) | 32.5 (32.1 to 38.7) | 409 MB | 78.3 KB |
| 500x500 | 0.48 MB | packed | 10100 | 0.42 | 0.93 / 1.40 | 109984 | 22.9 (21.7 to 24.1) | 21.7 (20.8 to 22.5) | 6.03 MB | 0.6 KB |
| 500x500 | 0.48 MB | object | 10100 | 0.44 | 2.85 / 3.13 | 109984 | 86.2 (83.3 to 93.0) | 49.1 (48.2 to 58.2) | 589 MB | 59.7 KB |
| 500x500 | 0.48 MB | snapshot | 938 | 141.73 | 0.62 / 0.94 | 123064 | 37.3 (36.5 to 42.6) | 39.8 (36.6 to 46.4) | 448 MB | 489.0 KB |
| 1000x1000 | 1.91 MB | packed | 10100 | 0.40 | 2.11 / 2.93 | 457317 | 24.3 (23.9 to 25.7) | 25.1 (24.0 to 25.8) | 6.41 MB | 0.6 KB |
| 1000x1000 | 1.91 MB | object | 10100 | 0.45 | 12.3 / 18.2 | 457317 | 386 (348 to 394) | 216 (208 to 232) | 2443 MB | 247.7 KB |
| 1000x1000 | 1.91 MB | snapshot | 306 | 428.08 | 1.83 / 2.58 | 484907 | 59.5 (55.9 to 63.5) | 58.4 (55.9 to 63.2) | 586 MB | 1959.7 KB |

## B3. Image to pattern conversion

Images: flat.png, gradient.png, noise.png. Palettes: 60, 500, 1000 colours. 5 runs after one warm-up, median (v1 naive: one run, no warm-up). The warm-up run is reported separately as the cold first run (image not yet decoded, code not yet optimized). End to end = decode + resize + convert; for v4 also the round trip to the worker. Colour reduction is median cut unless stated. \* = v1 measured on a row sample and extrapolated (more than 1e+8 CIEDE2000 calls).

### End to end time: worst case and median case over all images and palettes

| Variant | 200: worst | 200: median case | 500: worst | 500: median case | 1000: worst | 1000: median case | Worst cold first run | Mean deltaE (all cases) | Longest main-thread task |
|---|---|---|---|---|---|---|---|---|---|
| v1 naive | 15.63 s | 7.68 s | 95.03 s\* | 47.01 s | 364.56 s\* | 180.90 s | n/a | 5.79 | 36642 ms |
| v2 cache | 0.59 s | 0.05 s | 5.22 s | 0.33 s | 11.22 s | 0.36 s | 11.21 s | 5.95 | 11810 ms |
| v3 n=16 | 0.02 s | 0.01 s | 0.03 s | 0.02 s | 0.05 s | 0.03 s | 0.05 s | 9.20 | 581 ms |
| v3 n=32 | 0.02 s | 0.01 s | 0.04 s | 0.03 s | 0.06 s | 0.04 s | 0.07 s | 8.24 | 639 ms |
| v3 n=64 | 0.04 s | 0.02 s | 0.05 s | 0.03 s | 0.07 s | 0.04 s | 0.07 s | 7.35 | 579 ms |
| v3 n=32 kmeans | 0.02 s | 0.02 s | 0.05 s | 0.03 s | 0.09 s | 0.04 s | 0.09 s | 7.44 | 677 ms |
| v3 n=32 dither | 0.03 s | 0.02 s | 0.06 s | 0.04 s | 0.11 s | 0.09 s | 0.12 s | 11.65 | 645 ms |
| v4 worker n=32 | 0.02 s | 0.01 s | 0.04 s | 0.02 s | 0.06 s | 0.04 s | 0.07 s | 8.24 | 0.00 ms |
| v4 worker n=64 | 0.03 s | 0.02 s | 0.05 s | 0.03 s | 0.06 s | 0.04 s | 0.07 s | 7.35 | 0.00 ms |
| v4 worker n=32 dither | 0.03 s | 0.02 s | 0.05 s | 0.04 s | 0.11 s | 0.09 s | 0.12 s | 11.65 | 0.00 ms |

### Stages at 1000x1000, 500-colour palette (ms, median)

| Image | Variant | Total | Resize | Lab | Quantize | Map | Dither | Mean deltaE | Colours used |
|---|---|---|---|---|---|---|---|---|---|
| flat.png | v1 naive | 180904\* | 6.30 | 127 | 0.00 | 180771 | 0.00 | 3.66 | 8 |
| flat.png | v2 cache | 19.7 | 6.60 | 0.00 | 0.00 | 13.5 | 0.00 | 3.74 | 8 |
| flat.png | v3 n=16 | 28.9 | 6.80 | 0.00 | 7.20 | 14.8 | 0.00 | 3.66 | 8 |
| flat.png | v3 n=32 | 27.8 | 6.30 | 0.00 | 6.50 | 14.6 | 0.00 | 3.66 | 8 |
| flat.png | v3 n=64 | 28.3 | 6.40 | 0.00 | 6.70 | 14.6 | 0.00 | 3.66 | 8 |
| flat.png | v3 n=32 kmeans | 26.0 | 6.20 | 0.00 | 6.80 | 13.1 | 0.00 | 3.66 | 8 |
| flat.png | v3 n=32 dither | 77.7 | 6.30 | 0.00 | 6.70 | 0.00 | 64.4 | 8.54 | 8 |
| flat.png | v4 worker n=32 | 25.1 | 6.30 | 0.00 | 6.50 | 10.7 | 0.00 | 3.66 | 8 |
| flat.png | v4 worker n=64 | 21.7 | 5.90 | 0.00 | 6.40 | 9.00 | 0.00 | 3.66 | 8 |
| flat.png | v4 worker n=32 dither | 71.0 | 6.20 | 0.00 | 6.40 | 0.00 | 57.4 | 8.54 | 8 |
| gradient.png | v1 naive | 181662\* | 9.10 | 123 | 0.00 | 181530 | 0.00 | 4.25 | 119 |
| gradient.png | v2 cache | 363 | 10.1 | 0.00 | 0.00 | 351 | 0.00 | 4.40 | 126 |
| gradient.png | v3 n=16 | 34.0 | 10.1 | 0.00 | 7.70 | 16.1 | 0.00 | 8.60 | 16 |
| gradient.png | v3 n=32 | 37.0 | 10.1 | 0.00 | 7.90 | 18.9 | 0.00 | 7.11 | 29 |
| gradient.png | v3 n=64 | 42.2 | 9.70 | 0.00 | 7.60 | 24.3 | 0.00 | 5.94 | 50 |
| gradient.png | v3 n=32 kmeans | 40.8 | 9.70 | 0.00 | 9.40 | 19.7 | 0.00 | 6.23 | 32 |
| gradient.png | v3 n=32 dither | 90.4 | 9.90 | 0.00 | 7.70 | 0.00 | 73.0 | 10.93 | 29 |
| gradient.png | v4 worker n=32 | 38.6 | 9.90 | 0.00 | 8.20 | 17.7 | 0.00 | 7.11 | 29 |
| gradient.png | v4 worker n=64 | 35.3 | 9.90 | 0.00 | 7.80 | 17.4 | 0.00 | 5.94 | 50 |
| gradient.png | v4 worker n=32 dither | 84.7 | 9.20 | 0.00 | 7.80 | 0.00 | 66.7 | 10.93 | 29 |
| noise.png | v1 naive | 179498\* | 7.30 | 124 | 0.00 | 179367 | 0.00 | 3.61 | 500 |
| noise.png | v2 cache | 5634 | 8.20 | 0.00 | 0.00 | 5626 | 0.00 | 3.73 | 500 |
| noise.png | v3 n=16 | 48.7 | 7.60 | 0.00 | 24.6 | 16.7 | 0.00 | 14.06 | 16 |
| noise.png | v3 n=32 | 51.9 | 7.40 | 0.00 | 26.0 | 18.8 | 0.00 | 11.39 | 31 |
| noise.png | v3 n=64 | 61.3 | 8.10 | 0.00 | 30.3 | 23.4 | 0.00 | 8.47 | 63 |
| noise.png | v3 n=32 kmeans | 87.7 | 7.70 | 0.00 | 62.5 | 17.5 | 0.00 | 9.41 | 32 |
| noise.png | v3 n=32 dither | 108 | 7.70 | 0.00 | 25.9 | 0.00 | 73.9 | 12.99 | 31 |
| noise.png | v4 worker n=32 | 56.2 | 7.20 | 0.00 | 30.2 | 15.6 | 0.00 | 11.39 | 31 |
| noise.png | v4 worker n=64 | 54.6 | 7.70 | 0.00 | 27.9 | 18.1 | 0.00 | 8.47 | 63 |
| noise.png | v4 worker n=32 dither | 101 | 7.20 | 0.00 | 27.4 | 0.00 | 65.7 | 12.99 | 31 |

### Sensitivity to palette size at 1000x1000 (end to end ms, worst image)

| Variant | 60 colours | 500 colours | 1000 colours |
|---|---|---|---|
| v1 naive | 22969 | 181662\* | 364561\* |
| v2 cache | 748 | 5634 | 11222 |
| v3 n=16 | 47.0 | 48.7 | 49.7 |
| v3 n=32 | 53.2 | 51.9 | 57.1 |
| v3 n=64 | 51.2 | 61.3 | 70.7 |
| v3 n=32 kmeans | 83.3 | 87.7 | 93.8 |
| v3 n=32 dither | 105 | 108 | 113 |
| v4 worker n=32 | 42.0 | 56.2 | 52.6 |
| v4 worker n=64 | 47.4 | 54.6 | 63.0 |
| v4 worker n=32 dither | 112 | 101 | 109 |

### Median cut vs k-means (n = 32, averaged over all sizes and palettes)

| Image | Median cut: quantize ms | Median cut: deltaE | k-means: quantize ms | k-means: deltaE |
|---|---|---|---|---|
| flat.png | 2.93 | 5.59 | 3.11 | 5.58 |
| gradient.png | 3.91 | 8.20 | 5.90 | 7.26 |
| noise.png | 13.2 | 10.92 | 30.5 | 9.48 |

## B4. PDF export

50x50 cells per A4 page, coloured cells with a vector symbol each, cover with raster preview, legend with every used colour (500-colour palette, all used). Each run is a fresh Node process that exports inside a worker thread; 5 runs after a warm-up, median (min to max). Peak RSS is the whole process, Node itself included; peak heap is the worker's JS heap + buffers above its starting point.

| Grid | Strategy | Runs | Total | Time to first page | Pages | File size | Peak heap | Peak RSS | Progress events |
|---|---|---|---|---|---|---|---|---|---|
| 200x200 | naive | 5 | 2.44 s (2.40 s to 2.53 s) | 199 ms | 28 | 1.04 MB | 292 MB | 475 MB | 28 |
| 200x200 | stream | 5 | 0.34 s (0.33 s to 0.40 s) | 68.5 ms | 28 | 0.36 MB | 21 MB | 131 MB | 28 |
| 500x500 | naive | 5 | 15.00 s (14.75 s to 15.13 s) | 279 ms | 112 | 6.16 MB | 1441 MB | 1722 MB | 112 |
| 500x500 | stream | 5 | 1.18 s (1.17 s to 1.21 s) | 132 ms | 112 | 1.92 MB | 31 MB | 147 MB | 112 |
| 1000x1000 | naive | 0 | did not finish: Worker terminated due to reaching memory limit: JS heap out of memory |  |  |  |  |  |  |
| 1000x1000 | stream | 5 | 4.26 s (4.21 s to 4.44 s) | 313 ms | 412 | 7.52 MB | 68 MB | 196 MB | 412 |

Same export (stream strategy) in a Web Worker in Chromium:

| Grid | Total (wall) | Time to first page | Longest main-thread task | Pages | File size |
|---|---|---|---|---|---|
| 200x200 | 0.36 s (0.31 s to 0.38 s) | 59.7 ms | 0.00 ms | 28 | 0.36 MB |
| 500x500 | 1.07 s (1.05 s to 1.08 s) | 110 ms | 0.00 ms | 112 | 1.92 MB |
| 1000x1000 | 3.82 s (3.80 s to 3.92 s) | 299 ms | 0.00 ms | 412 | 7.52 MB |

## Which strategies and variants won

- **Rendering: S3 (WebGL) on a machine with a GPU.** At 1000x1000 its p95 frame time is 0.8 ms at every zoom level, against 10.7 ms for S2 at 16 px and 17.3 ms for S2 at 12 px. Its cost follows the number of screen pixels, so 200x200 and 1000x1000 are indistinguishable. S2 opens faster (9 ms against 136 ms, because S3 builds a symbol atlas and compiles a shader) but both are far inside the 1 s target.
- **Rendering without a GPU: S2.** With canvas 2D drawn on the CPU, S2 keeps 11.3 ms at 16 px and 16.7 ms at 12 px. S3 on SwiftShader drops to about 80 ms per frame once symbols are visible.
- **S1 is rejected at every size**, including 200x200 (p95 255 ms).
- **History: typed-array diffs ("packed").** 6.4 MB for 10,100 actions at 1000x1000, undo-all in 24 ms. The object form from the spec holds 2,443 MB for the same actions and takes 386 ms to undo them. Snapshots cost 1.9 MB and 0.43 ms per single-cell edit.
- **Conversion: V3 in a worker (V4).** 47 to 63 ms end to end at 1000x1000 with n = 64 depending on palette size, about 110 ms with dithering, and no main-thread task over 50 ms. V2 is fine on real-looking images (0.36 s) but takes 11.2 s on noise with a 1000-colour palette, which misses the 10 s target. V1 needs minutes.
- **PDF: hand-written content streams.** 4.3 s and 196 MB peak RSS for a 412-page 1000x1000 chart. The pdf-lib per-cell calls take 15 s and 1.7 GB at 500x500 and run out of a 4 GB heap at 1000x1000.

Every 1000x1000 target is met by at least one strategy, so no escalation beyond S3 and the stream PDF writer was needed. WASM was not tried because the JavaScript worker is already about 150 times under the conversion target.

## Top 3 bottlenecks

1. **Per-cell text drawing in canvas 2D.** `fillText` per visible cell is what S2 spends its frame on: 0.7 ms per frame with no symbols (2 and 8 px), 17 ms with about 6,400 symbols on screen (12 px), 10.7 ms with 3,600 (16 px). It is also why S1 needs seconds. Symbol count on screen, not grid size, decides the frame time.
2. **CIEDE2000 called per pixel.** One call costs roughly 0.2 to 0.4 microseconds, so a million pixels against 500 colours is about 190 s (V1). Anything that bounds the number of calls by the number of distinct colours (V3: n x palette size) removes the problem: the map stage is 20 ms.
3. **One JS object per cell.** It shows up twice: the `{ index, prev, next }` history (about 50 bytes per changed cell, 2.4 GB) and pdf-lib operator objects in the naive PDF (about 7 KB per cell at peak, out of memory at 1M cells). In both cases the fix is the same: typed arrays or a string buffer flushed per page.

## Recommendation

Adopt for the real app:

- **Grid as `Uint16Array`**, 1.91 MB at 1000x1000.
- **History as typed-array diffs**: row runs plus a single value when the action is uniform (pencil, fill, replace), per-cell values otherwise. This changes the data model line in section 4 of the spec, which asks for `{ index, prev, next }[]`. That form is fine for pencil strokes and should not be used for fills.
- **WebGL renderer as the default**, with the grid as an R16UI texture, a palette texture and a symbol atlas, all resolved in one fragment shader. Edits are a 1-texel `texSubImage2D`; whole-grid operations re-upload 2 MB in 3 ms.
- **Canvas 2D (S2) kept as the fallback** when WebGL2 is missing or software-rendered. Detect it at startup through `WEBGL_debug_renderer_info` (SwiftShader, llvmpipe) or a first-frame timing check.
- **Conversion as median cut to n colours plus CIEDE2000 on the n colours, in a worker.** Expose n and dithering to the user; both are cheap enough to recompute live while a slider moves.
- **PDF written as one compressed content stream per page, in a worker**, with progress per page. Keep pdf-lib for the document structure, fonts and legend only.

Needs a deeper look:

- **S2 below 16 px.** If the canvas fallback has to be as good as WebGL, its symbols need a glyph cache (pre-rendered sprites blitted with `drawImage`) or a higher symbol threshold. As measured it misses 16.7 ms at 12 px by a small margin and has little headroom at 16 px.
- **A weak integrated GPU.** The only real GPU tested is an RTX 5060 Ti. S3 has a factor of 20 of headroom there, which says nothing precise about a ten-year-old laptop. Run `npm run bench:render` on the weakest machine the product should support.
- **Real images and a real palette.** The fixtures are synthetic and the palette is random RGB. Timing conclusions should hold (they depend on pixel and colour counts), quality conclusions need real photos and the real DMC and Anchor tables.
- **Symbol font.** The PDF uses standard fonts and substitutes symbols they lack; the canvas uses whatever the system font has. The product needs one symbol font used by both, embedded once in the PDF.
- **Cold start of conversion.** The first conversion in a session is the slowest one measured (up to 0.12 s for V4 here, 11 s for V2). It is still inside the target for V4, but it is the number a user actually sees.

## Open questions

- [x] **Is k-means or median cut better for quality vs speed?** k-means is better on quality and still fast. At n = 32 it lowers mean deltaE from 8.20 to 7.26 on the gradient and from 10.92 to 9.48 on noise, for 2 to 17 ms more quantize time. On flat images they tie. Median cut seeded k-means is a reasonable default; confirm on real photos.
- [x] **At what cell size do symbols become worth drawing?** With WebGL the cost is flat, so it is a legibility question, not a performance one: 12 px worked in the PDF and screen checks, smaller was not evaluated visually. With canvas 2D the limit is performance: 16 px is safe (10.7 ms), 12 px is not (17.3 ms).
- [x] **Does S2 (canvas 2D) meet the 1000x1000 targets, or is WebGL (S3) the default?** S2 meets every target at the four zoom levels of the spec. WebGL should still be the default: it has 13 times more headroom at 16 px and S2 fails at 12 px.
- [x] **Does WASM/Rust for conversion pay off vs a Worker with typed arrays at 1000x1000?** Not needed. The worker takes about 60 ms against a 10 s target. Revisit only if exact per-pixel matching (V1 or V2 quality) becomes a requirement.
- [ ] **Does the Tauri webview match Chromium results?** Not measured: there is no Tauri shell yet. WebView2 on Windows is Chromium-based, so results should carry over there. WebKit on macOS and Linux is the unknown, especially R16UI textures, `textureGrad` and `OffscreenCanvas` in workers.
- [x] **Is a 1000x1000 PDF usable, or should export offer page ranges / volumes?** Technically yes: 412 pages, 7.5 MB, 4.3 s. Whether anyone wants a 400-page chart in one file is a product question; page ranges are cheap to add because pages are generated independently.
- [x] **Anything else discovered during the work**
  - The history format in the spec does not scale to fills (see above).
  - WebGL rendered on the CPU is slower than canvas 2D rendered on the CPU, so "WebGL everywhere" is the wrong rule.
  - V2's colour cache has a bad worst case: with a high-entropy image it degenerates to one CIEDE2000 search per 15-bit bucket (32,768 x palette size).
  - The measured paint latency (under 1 ms) is pipeline cost only. On a 60 Hz display add up to 16.7 ms of vsync wait, still well inside 50 ms.
