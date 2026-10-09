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
