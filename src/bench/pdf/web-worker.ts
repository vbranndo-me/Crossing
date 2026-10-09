// B4 in a real Web Worker: confirms the Node numbers carry over and the main thread stays free.
import { makePatternGrid } from '../../core/grid.ts';
import { makePalette } from '../../core/palette.ts';
import { exportPdf } from '../../core/pdf.ts';

self.onmessage = async (e: MessageEvent<{ size: number; paletteSize: number }>) => {
  const { size, paletteSize } = e.data;
  const palette = makePalette(paletteSize);
  const grid = makePatternGrid(size, size, paletteSize);
  const t0 = performance.now();
  const result = await exportPdf(grid, palette, { strategy: 'stream' }, (p) => self.postMessage({ type: 'progress', ...p }));
  self.postMessage(
    { type: 'done', totalMs: performance.now() - t0, firstPageMs: result.firstPageMs, pageCount: result.pageCount, bytes: result.bytes },
    { transfer: [result.bytes.buffer] },
  );
};
