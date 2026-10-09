import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

const pages = ['render', 'convert', 'pdf'].map((b) => [b, `src/bench/${b}/index.html`]).filter(([, f]) => existsSync(f));

// One minimal HTML harness per browser benchmark. Fixture images are served from /images/.
export default defineConfig({
  publicDir: 'fixtures',
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      input: Object.fromEntries(pages),
    },
  },
  worker: { format: 'es' },
});
