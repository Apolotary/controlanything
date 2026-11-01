import { defineConfig } from 'vite';

// Built into dist/ and served by the server at /sim/ (same origin as /ws and /api).
// `npm run dev:hmr -w @ce/sim` runs Vite's own dev server on :5175 with /api and /ws proxied.
export default defineConfig({
  base: '/sim/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/quest': 'http://127.0.0.1:8787',
    },
  },
});
