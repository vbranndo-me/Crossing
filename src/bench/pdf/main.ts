// B4 browser harness. Driven by run.ts through window.bench.
const bench = {
  /** Export in a fresh Web Worker; returns timings plus how long the main thread was ever blocked. */
  run(size: number, paletteSize: number) {
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    const worker = new Worker(new URL('./web-worker.ts', import.meta.url), { type: 'module' });
    let progressEvents = 0;
    const t0 = performance.now();
    return new Promise<Record<string, number>>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message));
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') {
          progressEvents++;
          return;
        }
        const wallMs = performance.now() - t0;
        worker.terminate();
        // Give pending long-task entries a moment to arrive.
        setTimeout(() => {
          observer.disconnect();
          resolve({
            wallMs,
            totalMs: e.data.totalMs,
            firstPageMs: e.data.firstPageMs,
            pageCount: e.data.pageCount,
            fileBytes: e.data.bytes.length,
            progressEvents,
            longestTaskMs: Math.max(0, ...longTasks),
          });
        }, 100);
      };
      worker.postMessage({ size, paletteSize });
    });
  },
};

export type PdfBench = typeof bench;
(window as unknown as { bench: PdfBench }).bench = bench;
