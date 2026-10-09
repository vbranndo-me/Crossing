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
