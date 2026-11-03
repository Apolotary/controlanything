import { defineConfig } from 'vite';

// Built into dist/ and served by the server at /companion/ (same origin as /ws).
// `npm run dev:hmr -w @ce/companion` runs Vite's own dev server on :5173 with /api and /ws proxied.
export default defineConfig({
  base: '/companion/',
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true,
    rollupOptions: { input: { companion: 'index.html', vsynth: 'vsynth/index.html', tracking: 'tracking/index.html', canvas: 'canvas/index.html' } },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
