// B1 harness. Query: ?strategy=s1|s2|s3&size=1000&palette=500. Driven by run.ts through window.bench.
import { makePatternGrid } from '../../core/grid.ts';
import { makePalette } from '../../core/palette.ts';
import { rng } from '../../core/rng.ts';
import { frameStats, percentile } from '../stats.ts';
import { createS1 } from './s1.ts';
import { createS2 } from './s2.ts';
import { createS3 } from './s3.ts';
import type { Camera, Renderer, Strategy } from './types.ts';

const query = new URLSearchParams(location.search);
const strategy = (query.get('strategy') ?? 's2') as Strategy;
const size = Number(query.get('size') ?? 200);
const paletteSize = Number(query.get('palette') ?? 500);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const VIEW_W = canvas.width;
const VIEW_H = canvas.height;

// The "project" being opened: generated up front, not part of any measurement.
const palette = makePalette(paletteSize);
const grid = makePatternGrid(size, size, paletteSize);
const cam: Camera = { x: 0, y: 0, scale: 1 };
let renderer: Renderer;

const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const heapMB = () => {
  (globalThis as { gc?: () => void }).gc?.();
  return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 2 ** 20;
};
const tri = (t: number) => 1 - Math.abs(1 - 2 * (t % 1)); // 0 -> 1 -> 0

function fit(): void {
  cam.scale = Math.min(VIEW_W / size, VIEW_H / size);
  cam.x = (size - VIEW_W / cam.scale) / 2;
  cam.y = (size - VIEW_H / cam.scale) / 2;
}

function center(scale: number): void {
  cam.scale = scale;
  cam.x = (size - VIEW_W / scale) / 2;
  cam.y = (size - VIEW_H / scale) / 2;
}

/** Render every frame for `ms`, moving the camera as a function of elapsed time. */
async function animate(ms: number, update: (t: number) => void) {
  const deltas: number[] = [];
  const cpu: number[] = [];
  const start = await raf();
  let last = start;
  while (last - start < ms) {
    update((last - start) / ms);
    const c0 = performance.now();
    renderer.render(cam);
    cpu.push(performance.now() - c0);
    const next = await raf();
    deltas.push(next - last);
    last = next;
  }
  return { ...frameStats(deltas), cpuP50: percentile(cpu, 0.5), cpuP95: percentile(cpu, 0.95), heapMB: heapMB() };
}

// Pencil tool: pointer events edit the grid; the frame loop flushes the repaint.
let painting = 0;
let lastCell = -1;
function paintAt(e: PointerEvent): void {
  const x = Math.floor(cam.x + e.clientX / cam.scale);
  const y = Math.floor(cam.y + e.clientY / cam.scale);
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = y * size + x;
  if (index === lastCell) return;
  lastCell = index;
  grid.cells[index] = painting;
  renderer.cellChanged(index);
}
canvas.addEventListener('pointerdown', (e) => {
  painting = 1 + ((e.pointerId * 7919) % paletteSize);
  lastCell = -1;
  paintAt(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (painting) paintAt(e);
});
canvas.addEventListener('pointerup', () => {
  painting = 0;
});

const bench = {
  config: { strategy, size, paletteSize, viewport: [VIEW_W, VIEW_H] },

  /** Time to first frame: build the renderer for an in-memory project and present a fit-to-view frame. */
  async open() {
    const t0 = performance.now();
    renderer = { s1: createS1, s2: createS2, s3: createS3 }[strategy](canvas, grid, palette);
    fit();
    renderer.render(cam);
    await raf();
    await raf();
    return { firstFrameMs: performance.now() - t0, layerMB: renderer.layerBytes() / 2 ** 20, heapMB: heapMB() };
  },

  /** Continuous drag from one corner of the grid to the opposite one and back. */
  async pan(scale: number, ms: number, warmupMs: number) {
    const spanX = Math.max(0, size - VIEW_W / scale);
    const spanY = Math.max(0, size - VIEW_H / scale);
    const move = (t: number) => {
      cam.scale = scale;
      cam.x = spanX * tri(t);
      cam.y = spanY * tri(t);
    };
    await animate(warmupMs, move);
    return animate(ms, move);
  },

  /** Continuous zoom between 2 and 32 px per cell around the grid centre, two cycles. */
  async zoom(ms: number, warmupMs: number) {
    const move = (t: number) => center(2 * Math.pow(16, tri(t * 2)));
    await animate(warmupMs, move);
    return animate(ms, move);
  },

  /**
   * Pencil strokes through dispatched pointer events (down, 3 moves, up). Like real rAF-aligned
   * input, each event is dispatched at the start of a frame and repainted in that same frame;
   * latency runs from dispatch until the next frame starts, i.e. until the repaint was submitted.
   */
  async paint(scale: number, strokes: number, capMs: number) {
    center(scale);
    renderer.render(cam);
    await raf();
    const rand = rng(11);
    const latency: number[] = [];
    const started = performance.now();
    // Keep strokes inside the part of the grid that is on screen.
    const pad = 4 * scale;
    const x0 = Math.max(0, -cam.x * scale) + pad;
    const y0 = Math.max(0, -cam.y * scale) + pad;
    const w = Math.min(VIEW_W, (size - cam.x) * scale) - pad - x0;
    const h = Math.min(VIEW_H, (size - cam.y) * scale) - pad - y0;
    let done = 0;
    const send = async (type: string, id: number, x: number, y: number) => {
      const t0 = performance.now();
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true }));
      renderer.flush(cam);
      await raf();
      latency.push(performance.now() - t0);
    };
    for (; done < strokes && performance.now() - started < capMs; done++) {
      let x = x0 + rand() * w;
      let y = y0 + rand() * h;
      const dx = (rand() < 0.5 ? -1 : 1) * scale;
      const dy = (rand() < 0.5 ? -1 : 1) * scale * (rand() < 0.5 ? 0 : 1);
      await send('pointerdown', done + 1, x, y);
      for (let k = 0; k < 3; k++) await send('pointermove', done + 1, (x += dx), (y += dy));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: done + 1, clientX: x, clientY: y, bubbles: true }));
    }
    return {
      strokes: done,
      samples: latency.length,
      p50: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
      max: Math.max(...latency),
    };
  },

  /** Replace one colour with another across the whole chart, then repaint (fit-to-view). */
  async replace(reps: number) {
    fit();
    renderer.render(cam);
    await raf();
    const times: number[] = [];
    const cells = grid.cells;
    for (let k = 0; k < reps; k++) {
      // Region colours are indices 1..48; rotate through them so every rep changes many cells.
      const from = 1 + (k % 24);
      const to = 25 + (k % 24);
      const t0 = performance.now();
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] === from) cells[i] = to;
        else if (cells[i] === to) cells[i] = from;
      }
      renderer.gridChanged();
      renderer.render(cam);
      await raf(); // next frame starts: the repaint was submitted
      times.push(performance.now() - t0);
    }
    return { median: percentile(times, 0.5), max: Math.max(...times) };
  },
};

export type RenderBench = typeof bench;
(window as unknown as { bench: RenderBench }).bench = bench;
