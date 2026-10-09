import { defineConfig } from 'vite';

// One minimal HTML harness per browser benchmark. Fixture images are served from /images/.
export default defineConfig({
  publicDir: 'fixtures',
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      input: {
        render: 'src/bench/render/index.html',
        convert: 'src/bench/convert/index.html',
        pdf: 'src/bench/pdf/index.html',
      },
    },
  },
  worker: { format: 'es' },
});
