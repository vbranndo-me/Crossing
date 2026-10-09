import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { build, preview } from 'vite';
import { ROOT } from './lib.ts';

export const VIEWPORT = { width: 1280, height: 720 };

/**
 * Fixed Chromium flags. Vsync and the frame rate limit are disabled so requestAnimationFrame
 * runs as fast as the pipeline allows: the rAF interval is then the real cost of a frame
 * instead of being rounded up to 16.7 ms.
 */
const ARGS = [
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-precise-memory-info',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--js-flags=--expose-gc',
];

/**
 * BENCH_GPU selects a stand-in for a machine with no usable GPU:
 * "swiftshader" runs WebGL on the CPU (what Chromium falls back to), "off" disables GPU
 * rasterization so canvas 2D is drawn by the CPU.
 */
export const GPU_MODE = process.env.BENCH_GPU ?? '';
if (GPU_MODE === 'swiftshader') ARGS.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
if (GPU_MODE === 'off') ARGS.splice(ARGS.indexOf('--enable-gpu'), 1, '--disable-gpu');

export interface Site {
  browser: Browser;
  /** Open a harness page, e.g. open('render', { strategy: 's2' }). */
  open(bench: string, params?: Record<string, string | number>): Promise<Page>;
  info(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Production build of the harness pages + static server + headless Chromium. */
export async function startSite(): Promise<Site> {
  await build({ root: ROOT, logLevel: 'warn' });
  const server = await preview({ root: ROOT, logLevel: 'warn', preview: { port: 4317 } });
  const base = server.resolvedUrls!.local[0];
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ARGS });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  return {
    browser,
    async open(bench, params = {}) {
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[page console] ${m.text()}`);
      });
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      await page.goto(`${base}src/bench/${bench}/index.html?${query}`);
      return page;
    },
    async info() {
      const page = await context.newPage();
      const gpu = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
      });
      await page.close();
      return { browser: `Chromium ${browser.version()} (headless)`, gpu, viewport: VIEWPORT, flags: ARGS };
    },
    async close() {
      await browser.close();
      await new Promise<void>((done) => server.httpServer.close(() => done()));
    },
  };
}
