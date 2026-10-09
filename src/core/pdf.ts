import {
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { Grid } from './grid.ts';
import { darkInk } from './palette.ts';
import type { Palette } from './palette.ts';

export interface PdfOptions {
  /**
   * naive: pdf-lib drawRectangle / drawText / drawLine per cell (baseline).
   * stream: one hand-written, deflated content stream per page.
   */
  strategy: 'naive' | 'stream';
  cellsPerPage?: number;
  title?: string;
}

export interface PdfProgress {
  phase: 'chart' | 'legend' | 'save';
  page: number;
  pages: number;
}

export interface PdfResult {
  bytes: Uint8Array;
  pageCount: number;
  chartPages: number;
  /** Time until the first chart page was complete (cover page included). */
  firstPageMs: number;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 36;
const CELL = 10;
const GRID_X = MARGIN + 22;
const GRID_TOP = PAGE_H - MARGIN - 30;
const SYMBOL_SIZE = 7;
const LEGEND_ROWS = 48;
/** Rough yield of one skein, in full cross stitches (14 count, 2 strands). */
const STITCHES_PER_SKEIN = 1600;

const num = (v: number) => String(Math.round(v * 100) / 100);

interface Glyph {
  font: number;
  text: string;
  hex: string;
  /** Advance width at SYMBOL_SIZE. */
  width: number;
}

interface Label {
  text: string;
  x: number;
  y: number;
  size: number;
}

/** Vector symbols come from the three symbol-capable standard fonts: nothing is embedded per cell. */
function glyphTable(palette: Palette, fonts: PDFFont[]): Glyph[] {
  const sets = fonts.map((f) => new Set(f.getCharacterSet()));
  return palette.entries.map((e, i) => {
    let text = e.symbol;
    let font = sets.findIndex((s) => text !== '' && s.has(text.codePointAt(0)!));
    if (font < 0) {
      // Not in any standard font: substitute a printable ASCII symbol.
      text = String.fromCharCode(0x21 + (i % 94));
      font = 0;
    }
    return { font, text, hex: fonts[font].encodeText(text).toString(), width: fonts[font].widthOfTextAtSize(text, SYMBOL_SIZE) };
  });
}

export async function exportPdf(
  grid: Grid,
  palette: Palette,
  options: PdfOptions,
  onProgress: (p: PdfProgress) => void = () => {},
): Promise<PdfResult> {
  const started = performance.now();
  const { width, height, cells } = grid;
  const per = options.cellsPerPage ?? 50;
  const doc = await PDFDocument.create();
  const context = doc.context;
  const fonts = [
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.ZapfDingbats),
    await doc.embedFont(StandardFonts.Symbol),
  ];
  const helv = fonts[0];
  const glyphs = glyphTable(palette, fonts);
  const fontKeys = ['F0', 'F1', 'F2'];
  const dark = palette.entries.map((_, i) => darkInk(palette, i));
  const color = (i: number) => rgb(palette.rgb[i * 3] / 255, palette.rgb[i * 3 + 1] / 255, palette.rgb[i * 3 + 2] / 255);
  const fillOp = palette.entries.map(
    (_, i) => `${num(palette.rgb[i * 3] / 255)} ${num(palette.rgb[i * 3 + 1] / 255)} ${num(palette.rgb[i * 3 + 2] / 255)} rg`,
  );

  // Cover page: title + raster preview at one pixel per cell (at most 1000 px a side).
  const step = Math.ceil(Math.max(width, height) / 1000);
  const pw = Math.floor(width / step);
  const ph = Math.floor(height / step);
  const pixels = new Uint8Array(pw * ph * 3);
  for (let y = 0, o = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++, o += 3) {
      const v = cells[y * step * width + x * step] * 3;
      pixels[o] = palette.rgb[v];
      pixels[o + 1] = palette.rgb[v + 1];
      pixels[o + 2] = palette.rgb[v + 2];
    }
  }
  const preview = context.register(
    context.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: pw, Height: ph, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
  );
  const cover = doc.addPage([PAGE_W, PAGE_H]);
  cover.drawText(options.title ?? 'Cross stitch chart', { x: MARGIN, y: PAGE_H - MARGIN - 24, size: 24, font: helv });
  cover.drawText(`${width} x ${height} stitches`, { x: MARGIN, y: PAGE_H - MARGIN - 44, size: 12, font: helv });
  const fitted = Math.min((PAGE_W - 2 * MARGIN) / pw, (PAGE_H - 2 * MARGIN - 70) / ph);
  cover.node.setXObject(PDFName.of('Preview'), preview);
  cover.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(pw * fitted, 0, 0, ph * fitted, MARGIN, PAGE_H - MARGIN - 60 - ph * fitted),
    drawObject('Preview'),
    popGraphicsState(),
  );

  // Chart pages.
  const pagesX = Math.ceil(width / per);
  const pagesY = Math.ceil(height / per);
  const chartPages = pagesX * pagesY;
  let firstPageMs = 0;
  for (let py = 0, n = 0; py < pagesY; py++) {
    for (let px = 0; px < pagesX; px++, n++) {
      const x0 = px * per;
      const y0 = py * per;
      const cols = Math.min(per, width - x0);
      const rows = Math.min(per, height - y0);
      const right = GRID_X + cols * CELL;
      const bottom = GRID_TOP - rows * CELL;

      // Header and axis labels (every 10 cells, in whole-chart coordinates).
      const labels: Label[] = [
        {
          text: `Page ${n + 1} of ${chartPages}   columns ${x0 + 1}-${x0 + cols}   rows ${y0 + 1}-${y0 + rows}`,
          x: MARGIN,
          y: PAGE_H - MARGIN - 9,
          size: 9,
        },
      ];
      for (let c = 0; c <= cols; c++) {
        if ((x0 + c) % 10 === 0) labels.push({ text: String(x0 + c), x: GRID_X + c * CELL - 4, y: GRID_TOP + 4, size: 6 });
      }
      for (let r = 0; r <= rows; r++) {
        if ((y0 + r) % 10 === 0) labels.push({ text: String(y0 + r), x: MARGIN, y: GRID_TOP - r * CELL - 2, size: 6 });
      }

      const page = doc.addPage([PAGE_W, PAGE_H]);
      if (options.strategy === 'naive') {
        drawChartNaive(page);
      } else {
        fontKeys.forEach((key, f) => page.node.setFontDictionary(PDFName.of(key), fonts[f].ref));
        page.node.addContentStream(context.register(context.flateStream(chartStream())));
      }
      if (n === 0) firstPageMs = performance.now() - started;
      onProgress({ phase: 'chart', page: n + 1, pages: chartPages });

      function drawChartNaive(page: PDFPage): void {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const v = cells[(y0 + r) * width + x0 + c];
            if (v === 0) continue;
            const x = GRID_X + c * CELL;
            const y = GRID_TOP - (r + 1) * CELL;
            const g = glyphs[v];
            page.drawRectangle({ x, y, width: CELL, height: CELL, color: color(v) });
            page.drawText(g.text, {
              x: x + (CELL - g.width) / 2,
              y: y + 2.5,
              size: SYMBOL_SIZE,
              font: fonts[g.font],
              color: dark[v] ? rgb(0, 0, 0) : rgb(1, 1, 1),
            });
          }
        }
        for (let c = 0; c <= cols; c++) {
          const bold = (x0 + c) % 10 === 0 || c === cols;
          const x = GRID_X + c * CELL;
          page.drawLine({ start: { x, y: GRID_TOP }, end: { x, y: bottom }, thickness: bold ? 0.9 : 0.25, color: bold ? rgb(0, 0, 0) : rgb(0.5, 0.5, 0.5) });
        }
        for (let r = 0; r <= rows; r++) {
          const bold = (y0 + r) % 10 === 0 || r === rows;
          const y = GRID_TOP - r * CELL;
          page.drawLine({ start: { x: GRID_X, y }, end: { x: right, y }, thickness: bold ? 0.9 : 0.25, color: bold ? rgb(0, 0, 0) : rgb(0.5, 0.5, 0.5) });
        }
        for (const l of labels) page.drawText(l.text, { x: l.x, y: l.y, size: l.size, font: helv });
      }

      function chartStream(): string {
        const out: string[] = [];
        // Cell colours: one rectangle per run of equal cells in a row.
        const text: string[][] = [[], [], [], [], [], []];
        for (let r = 0; r < rows; r++) {
          const y = GRID_TOP - (r + 1) * CELL;
          const row = (y0 + r) * width + x0;
          for (let c = 0; c < cols; ) {
            const v = cells[row + c];
            let end = c + 1;
            while (end < cols && cells[row + end] === v) end++;
            if (v !== 0) {
              out.push(`${fillOp[v]} ${GRID_X + c * CELL} ${num(y)} ${(end - c) * CELL} ${CELL} re f\n`);
              const g = glyphs[v];
              const bucket = text[g.font * 2 + (dark[v] ? 0 : 1)];
              for (let k = c; k < end; k++) {
                bucket.push(`1 0 0 1 ${num(GRID_X + k * CELL + (CELL - g.width) / 2)} ${num(y + 2.5)} Tm ${g.hex} Tj\n`);
              }
            }
            c = end;
          }
        }
        // Symbols: one text object per font and ink colour.
        for (let k = 0; k < 6; k++) {
          if (text[k].length === 0) continue;
          out.push(`BT /${fontKeys[k >> 1]} ${SYMBOL_SIZE} Tf ${k & 1} g\n`, ...text[k], 'ET\n');
        }
        // Grid lines: thin ones first, then the bold line every 10 cells and the border.
        for (const bold of [false, true]) {
          out.push(bold ? '0.9 w 0 G\n' : '0.25 w 0.5 G\n');
          for (let c = 0; c <= cols; c++) {
            if (((x0 + c) % 10 === 0 || c === cols || c === 0) !== bold) continue;
            const x = GRID_X + c * CELL;
            out.push(`${x} ${num(GRID_TOP)} m ${x} ${num(bottom)} l\n`);
          }
          for (let r = 0; r <= rows; r++) {
            if (((y0 + r) % 10 === 0 || r === rows || r === 0) !== bold) continue;
            const y = num(GRID_TOP - r * CELL);
            out.push(`${GRID_X} ${y} m ${right} ${y} l\n`);
          }
          out.push('S\n');
        }
        out.push('BT 0 g\n');
        for (const l of labels) out.push(`/F0 ${l.size} Tf 1 0 0 1 ${num(l.x)} ${num(l.y)} Tm ${helv.encodeText(l.text).toString()} Tj\n`);
        out.push('ET\n');
        return out.join('');
      }
    }
  }

  // Legend: every colour used in the chart, with stitch count and estimated skeins.
  const counts = new Uint32Array(palette.size + 1);
  for (let i = 0; i < cells.length; i++) counts[cells[i]]++;
  const used: number[] = [];
  for (let i = 1; i <= palette.size; i++) if (counts[i] > 0) used.push(i);
  const legendPages = Math.ceil(used.length / LEGEND_ROWS);
  for (let p = 0; p < legendPages; p++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const top = PAGE_H - MARGIN - 12;
    page.drawText(`Legend (${p + 1} of ${legendPages})`, { x: MARGIN, y: top, size: 12, font: helv });
    const columns: [string, number][] = [['Symbol', 0], ['Code', 60], ['Name', 150], ['Stitches', 330], ['Skeins', 420]];
    for (const [title, dx] of columns) page.drawText(title, { x: MARGIN + dx, y: top - 22, size: 8, font: helv });
    used.slice(p * LEGEND_ROWS, (p + 1) * LEGEND_ROWS).forEach((v, row) => {
      const y = top - 38 - row * 15;
      const e = palette.entries[v];
      const g = glyphs[v];
      page.drawRectangle({ x: MARGIN, y: y - 2, width: CELL, height: CELL, color: color(v), borderWidth: 0.25, borderColor: rgb(0, 0, 0) });
      page.drawText(g.text, { x: MARGIN + (CELL - g.width) / 2, y: y + 0.5, size: SYMBOL_SIZE, font: fonts[g.font], color: dark[v] ? rgb(0, 0, 0) : rgb(1, 1, 1) });
      page.drawText(`${e.brand} ${e.code}`, { x: MARGIN + 60, y, size: 8, font: helv });
      page.drawText(e.name, { x: MARGIN + 150, y, size: 8, font: helv });
      page.drawText(String(counts[v]), { x: MARGIN + 330, y, size: 8, font: helv });
      page.drawText(String(Math.ceil(counts[v] / STITCHES_PER_SKEIN)), { x: MARGIN + 420, y, size: 8, font: helv });
    });
    onProgress({ phase: 'legend', page: p + 1, pages: legendPages });
  }

  const bytes = await doc.save();
  onProgress({ phase: 'save', page: 1, pages: 1 });
  return { bytes, pageCount: doc.getPageCount(), chartPages, firstPageMs };
}
