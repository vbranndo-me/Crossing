// Builds results/REPORT.md from results/raw/*.json plus the hand-written notes in scripts/notes/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib.ts';

// The raw result files are plain JSON written by the benchmarks; they are read untyped here.
type Row = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const raw = (name: string): Row => {
  const file = resolve(ROOT, 'results/raw', `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};
const note = (name: string) => {
  const file = resolve(ROOT, 'scripts/notes', `${name}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '_Not written yet._';
};

const render = raw('render');
const renderWebglCpu = raw('render-gpu-swiftshader');
const renderCanvasCpu = raw('render-gpu-off');
const history = raw('history');
const convert = raw('convert');
const pdf = raw('pdf');

const SIZES = [200, 500, 1000];
const ZOOMS = [2, 8, 16, 32];
const STRATEGY: Record<string, string> = { s1: 'S1 naive canvas', s2: 'S2 canvas culled + cached', s3: 'S3 WebGL' };
const WORKER_VARIANT = 'v4 worker n=64';

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const sec = (v: number) => `${(v / 1000).toFixed(2)} s`;
const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 2 : 0)} MB`;
const mark = (ok: boolean) => (ok ? 'PASS' : '**FAIL**');
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const range = (s: { median: number; min: number; max: number }, f: (v: number) => string = ms) => `${f(s.median)} (${f(s.min)} to ${f(s.max)})`;

const out: string[] = [];
const p = (...lines: string[]) => out.push(...lines, '');

// ---- helpers over the raw data ----
const renderRow = (strategy: string, size: number, data = render): Row => data?.results.find((r: Row) => r.strategy === strategy && r.size === size);
/** Worst p95 frame time over the four zoom levels of the spec and the zoom scenario. */
const worstFrame = (r: Row) => Math.max(...ZOOMS.map((z) => r.metrics[`pan${z}.p95`].median), r.metrics['zoom.p95'].median);
const worstPaint = (r: Row) => Math.max(...ZOOMS.map((z) => r.metrics[`paint${z}.p95`].median));
const convertRows = (size: number, variant: string): Row[] => convert?.results.filter((r: Row) => r.size === size && r.variant === variant) ?? [];
const worst = (rows: Row[], f: (r: Row) => number) => (rows.length ? Math.max(...rows.map(f)) : NaN);
const pdfRow = (size: number, strategy: string): Row => pdf?.results.find((r: Row) => r.size === size && r.strategy === strategy);

// ---- header ----
p('# Cross Stitch Tool: Performance Benchmark Report (Phase 1)');
p(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`scripts/make-report.ts\` from \`results/raw/*.json\`. Spec: [BENCHMARK.md](../BENCHMARK.md).`);
if ([render, history, convert, pdf].some((d) => d?.quick)) {
  p('> **Warning: at least one result file comes from a BENCH_QUICK smoke run. These numbers are not valid measurements.**');
}
const machine = render?.machine ?? pdf?.machine ?? history?.machine;
if (machine) {
  p(
    '## Machine',
    table(
      ['CPU', 'Cores', 'RAM', 'OS', 'Node', 'Browser', 'GPU'],
      [[machine.cpu, machine.cores, `${machine.ramGB} GB`, machine.os, machine.node, machine.browser ?? 'n/a', machine.gpu ?? 'n/a']],
    ),
  );
}

p('## Assumptions', note('assumptions'));

// ---- targets ----
p('## Results vs targets');
p('Each cell is the median of the runs for the worst case of that area (worst zoom level, worst image and palette). Details and spread are in the sections below.');
{
  const rows: (string | number)[][] = [];
  const add = (
    area: string,
    what: string,
    targets: number[],
    value: (size: number) => number | undefined,
    fmt: (v: number) => string,
    ok: (v: number, t: number) => boolean = (v, t) => v <= t,
  ) => {
    rows.push([
      area,
      what,
      ...SIZES.map((size, i) => {
        const v = value(size);
        return v === undefined || Number.isNaN(v) ? 'n/a' : `${fmt(v)} ${mark(ok(v, targets[i]))}`;
      }),
    ]);
  };
  const msUnit = (v: number) => `${ms(v)} ms`;
  const strategies = ['s2', 's3', 's1'];
  for (const s of strategies) add('Pan/zoom p95 frame time (<= 16.7 ms)', STRATEGY[s], [16.7, 16.7, 16.7], (size) => renderRow(s, size) && worstFrame(renderRow(s, size)), msUnit);
  for (const s of strategies) add('Paint latency p95 (<= 50 ms)', STRATEGY[s], [50, 50, 50], (size) => renderRow(s, size) && worstPaint(renderRow(s, size)), msUnit);
  for (const s of strategies) add('Whole-grid operation + repaint (<= 100 / 200 / 500 ms)', STRATEGY[s], [100, 200, 500], (size) => renderRow(s, size)?.metrics.replaceMs.median, msUnit);
  for (const s of strategies) add('Time to first frame on open (<= 300 / 500 / 1000 ms)', STRATEGY[s], [300, 500, 1000], (size) => renderRow(s, size)?.metrics.firstFrameMs.median, msUnit);
  add('Conversion end to end, worker (<= 2 / 5 / 10 s)', WORKER_VARIANT, [2000, 5000, 10000], (size) => worst(convertRows(size, WORKER_VARIANT), (r) => r.totalMs.median), sec);
  add('Main thread blocked during conversion (< 50 ms)', WORKER_VARIANT, [50, 50, 50], (size) => worst(convertRows(size, WORKER_VARIANT), (r) => r.longestTaskMs), msUnit, (v, t) => v < t);
  for (const s of ['stream', 'naive']) {
    add('PDF export (<= 5 / 15 / 45 s)', `pdf ${s}`, [5000, 15000, 45000], (size) => pdfRow(size, s)?.totalMs?.median, sec);
    add(
      'PDF peak memory (<= 200 / 400 / 800 MB)',
      `pdf ${s}, process peak RSS`,
      [200, 400, 800],
      (size) => pdfRow(size, s)?.peakRssBytes && pdfRow(size, s).peakRssBytes.median / 2 ** 20,
      (v) => `${v.toFixed(0)} MB`,
    );
  }
  add('Grid memory (trivial / trivial / <= 2 MB)', 'Uint16Array', [2, 2, 2], (size) => (size * size * 2) / 2 ** 20, (v) => `${v.toFixed(2)} MB`);
  p(table(['Area', 'Strategy', '200x200', '500x500', '1000x1000 (required)'], rows));
  const failedPdf: Row[] = pdf?.results.filter((r: Row) => r.failed) ?? [];
  if (failedPdf.length) p(failedPdf.map((r) => `- \`pdf ${r.strategy}\` at ${r.size}x${r.size} did not finish: ${r.failed}.`).join('\n'));
}

// ---- B1 ----
if (render) {
  const panZooms: number[] = render.config.panZooms;
  p('## B1. Rendering and interaction');
  p(
    `Viewport ${render.machine.viewport.width}x${render.machine.viewport.height}, ${render.config.palette}-colour palette, ${render.config.runs} runs per row (fresh page each), ` +
      `median shown. Frame time is the interval between animation frames with vsync and the frame-rate limit disabled, so it is the real cost of a frame. ` +
      `S1 on 500x500 and 1000x1000 was run once.`,
  );
  p(
    table(
      [
        'Strategy',
        'Grid',
        'First frame ms',
        `Pan p95 ms at ${panZooms.join(' / ')} px`,
        'Zoom p95 ms',
        'Zoom p99 ms',
        'Lowest avg FPS',
        'Most dropped frames (> 20 ms) per scenario',
        `Paint p95 ms at ${ZOOMS.join(' / ')} px`,
        'Replace colour + repaint ms',
        'Render layers MB',
        'JS heap MB',
      ],
      render.results.map((r: Row) => {
        const m = r.metrics;
        return [
          STRATEGY[r.strategy],
          r.size,
          ms(m.firstFrameMs.median),
          panZooms.map((z) => ms(m[`pan${z}.p95`].median)).join(' / '),
          ms(m['zoom.p95'].median),
          ms(m['zoom.p99'].median),
          Math.round(Math.min(...ZOOMS.map((z) => m[`pan${z}.fps`].median), m['zoom.fps'].median)),
          Math.max(...ZOOMS.map((z) => m[`pan${z}.dropped`].median), m['zoom.dropped'].median),
          ZOOMS.map((z) => ms(m[`paint${z}.p95`].median)).join(' / '),
          ms(m.replaceMs.median),
          m.layerMB.median.toFixed(1),
          Math.max(...ZOOMS.map((z) => m[`pan${z}.heapMB`].median), m['zoom.heapMB'].median).toFixed(1),
        ];
      }),
    ),
  );
  p('Spread across runs for the 1000x1000 grid, median (min to max), ms:');
  p(
    table(
      ['Strategy', 'First frame', 'Pan p95 at 12 px', 'Pan p95 at 16 px', 'Zoom p95', 'Paint p95 at 16 px', 'Replace + repaint'],
      ['s2', 's3']
        .filter((s) => renderRow(s, 1000))
        .map((s) => {
          const m = renderRow(s, 1000).metrics;
          return [STRATEGY[s], range(m.firstFrameMs), range(m['pan12.p95']), range(m['pan16.p95']), range(m['zoom.p95']), range(m['paint16.p95']), range(m.replaceMs)];
        }),
    ),
  );
  const extra = (
    [
      ['S3 WebGL on the CPU (SwiftShader)', renderRow('s3', 1000, renderWebglCpu)],
      ['S2 canvas 2D on the CPU (--disable-gpu)', renderRow('s2', 1000, renderCanvasCpu)],
    ] as [string, Row][]
  ).filter(([, r]) => r);
  if (extra.length) {
    p('### Without a usable GPU (1000x1000 only)');
    p(
      table(
        ['Setup', 'First frame ms', `Pan p95 ms at ${panZooms.join(' / ')} px`, 'Zoom p95 ms', `Paint p95 ms at ${ZOOMS.join(' / ')} px`, 'Replace + repaint ms'],
        extra.map(([name, r]) => [
          name,
          ms(r.metrics.firstFrameMs.median),
          panZooms.map((z) => ms(r.metrics[`pan${z}.p95`].median)).join(' / '),
          ms(r.metrics['zoom.p95'].median),
          ZOOMS.map((z) => ms(r.metrics[`paint${z}.p95`].median)).join(' / '),
          ms(r.metrics.replaceMs.median),
        ]),
      ),
    );
  }
}

// ---- B2 ----
if (history) {
  p('## B2. Data model and history');
  p(
    `${history.config.singleEdits} single-cell edits, then ${history.config.fills} flood fills capped at 50% of the grid, then undo all and redo all. ` +
      `${history.config.runs} runs, median. "packed" stores runs + values in typed arrays, "object" is the literal \`{ index, prev, next }[]\` from the spec, ` +
      `"snapshot" copies the whole grid per action (baseline; it gets fewer single edits so it fits in memory).`,
  );
  p(
    table(
      ['Grid', 'cells', 'History', 'Actions', 'Single edit us', 'Flood fill ms (avg / p95)', 'Avg cells per fill', 'Undo all ms', 'Redo all ms', 'History memory (measured)', 'Per action'],
      history.results.map((r: Row) => [
        `${r.size}x${r.size}`,
        mb(r.gridBytes),
        r.kind,
        r.actions,
        r.singleUs.median.toFixed(2),
        `${ms(r.fillMsAvg.median)} / ${ms(r.fillMsP95.median)}`,
        Math.round(r.fillCellsAvg),
        range(r.undoMs),
        range(r.redoMs),
        mb(r.heldBytes.median),
        `${(r.heldBytes.median / r.actions / 1024).toFixed(1)} KB`,
      ]),
    ),
  );
}

// ---- B3 ----
if (convert) {
  const results: Row[] = convert.results;
  const variants = [...new Set<string>(results.map((r) => r.variant))];
  const palettes: number[] = convert.config.palettes;
  const big = Math.max(...convert.config.sizes);
  const pal = palettes.includes(500) ? 500 : palettes[0];
  const star = (rows: Row[]) => (rows.some((r) => r.extrapolated) ? '\\*' : '');
  p('## B3. Image to pattern conversion');
  p(
    `Images: ${convert.config.images.join(', ')}. Palettes: ${palettes.join(', ')} colours. ${convert.config.runs} runs after one warm-up, median ` +
      `(v1 naive: one run, no warm-up). The warm-up run is reported separately as the cold first run (image not yet decoded, code not yet optimized). End to end = decode + resize + convert; for v4 also the round trip to the worker. Colour reduction is median cut unless stated. ` +
      `\\* = v1 measured on a row sample and extrapolated (more than ${Number(convert.config.maxNaiveOps).toExponential(0)} CIEDE2000 calls).`,
  );
  p('### End to end time: worst case and median case over all images and palettes');
  p(
    table(
      ['Variant', ...SIZES.flatMap((s) => [`${s}: worst`, `${s}: median case`]), 'Worst cold first run', 'Mean deltaE (all cases)', 'Longest main-thread task'],
      variants.map((v) => {
        const all = results.filter((r) => r.variant === v);
        return [
          v,
          ...SIZES.flatMap((size) => {
            const rows = convertRows(size, v);
            if (!rows.length) return ['n/a', 'n/a'];
            const totals = rows.map((r) => r.totalMs.median).sort((a, b) => a - b);
            return [`${sec(totals[totals.length - 1])}${star(rows)}`, sec(totals[Math.floor(totals.length / 2)])];
          }),
          all.some((r) => r.coldMs != null) ? sec(worst(all.filter((r) => r.coldMs != null), (r) => r.coldMs)) : 'n/a',
          (all.reduce((a, r) => a + r.meanDeltaE, 0) / all.length).toFixed(2),
          `${ms(worst(all, (r) => r.longestTaskMs))} ms`,
        ];
      }),
    ),
  );
  p(`### Stages at ${big}x${big}, ${pal}-colour palette (ms, median)`);
  p(
    table(
      ['Image', 'Variant', 'Total', 'Resize', 'Lab', 'Quantize', 'Map', 'Dither', 'Mean deltaE', 'Colours used'],
      results
        .filter((r) => r.size === big && r.paletteSize === pal)
        .map((r) => [
          r.image,
          r.variant,
          `${ms(r.totalMs.median)}${r.extrapolated ? '\\*' : ''}`,
          ms(r.stages.resize),
          ms(r.stages.lab),
          ms(r.stages.quantize),
          ms(r.stages.map),
          ms(r.stages.dither),
          r.meanDeltaE.toFixed(2),
          r.usedColors,
        ]),
    ),
  );
  p(`### Sensitivity to palette size at ${big}x${big} (end to end ms, worst image)`);
  p(
    table(
      ['Variant', ...palettes.map((n) => `${n} colours`)],
      variants.map((v) => [
        v,
        ...palettes.map((n) => {
          const rows = results.filter((r) => r.size === big && r.variant === v && r.paletteSize === n);
          return `${ms(worst(rows, (r) => r.totalMs.median))}${star(rows)}`;
        }),
      ]),
    ),
  );
  p('### Median cut vs k-means (n = 32, averaged over all sizes and palettes)');
  const avg = (image: string, variant: string, f: (r: Row) => number) => {
    const rows = results.filter((r) => r.image === image && r.variant === variant);
    return rows.reduce((a, r) => a + f(r), 0) / rows.length;
  };
  p(
    table(
      ['Image', 'Median cut: quantize ms', 'Median cut: deltaE', 'k-means: quantize ms', 'k-means: deltaE'],
      convert.config.images.map((image: string) => [
        image,
        ms(avg(image, 'v3 n=32', (r) => r.stages.quantize)),
        avg(image, 'v3 n=32', (r) => r.meanDeltaE).toFixed(2),
        ms(avg(image, 'v3 n=32 kmeans', (r) => r.stages.quantize)),
        avg(image, 'v3 n=32 kmeans', (r) => r.meanDeltaE).toFixed(2),
      ]),
    ),
  );
}

// ---- B4 ----
if (pdf) {
  p('## B4. PDF export');
  p(
    `${pdf.config.cellsPerPage}x${pdf.config.cellsPerPage} cells per A4 page, coloured cells with a vector symbol each, cover with raster preview, legend with every used colour ` +
      `(${pdf.config.palette}-colour palette, all used). Each run is a fresh Node process that exports inside a worker thread; ${pdf.config.runs} runs after a warm-up, median (min to max). ` +
      `Peak RSS is the whole process, Node itself included; peak heap is the worker's JS heap + buffers above its starting point.`,
  );
  p(
    table(
      ['Grid', 'Strategy', 'Runs', 'Total', 'Time to first page', 'Pages', 'File size', 'Peak heap', 'Peak RSS', 'Progress events'],
      pdf.results.map((r: Row) =>
        r.failed
          ? [`${r.size}x${r.size}`, r.strategy, r.runs, `did not finish: ${r.failed}`, '', '', '', '', '', '']
          : [
              `${r.size}x${r.size}`,
              r.strategy,
              r.runs,
              range(r.totalMs, sec),
              `${ms(r.firstPageMs.median)} ms`,
              r.pageCount,
              mb(r.fileBytes),
              mb(r.peakHeapBytes.median),
              mb(r.peakRssBytes.median),
              r.progressEvents,
            ],
      ),
    ),
  );
  if (pdf.browser?.length) {
    p('Same export (stream strategy) in a Web Worker in Chromium:');
    p(
      table(
        ['Grid', 'Total (wall)', 'Time to first page', 'Longest main-thread task', 'Pages', 'File size'],
        pdf.browser.map((r: Row) => [`${r.size}x${r.size}`, range(r.wallMs, sec), `${ms(r.firstPageMs.median)} ms`, `${ms(r.longestTaskMs.median)} ms`, r.pageCount, mb(r.fileBytes)]),
      ),
    );
  }
}

p(note('analysis'));

const file = resolve(ROOT, 'results/REPORT.md');
writeFileSync(file, out.join('\n'));
console.log(`wrote ${file}`);
