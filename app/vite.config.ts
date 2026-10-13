import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the build works wherever it is served from (GitHub Pages serves it under /Crossing/).
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
