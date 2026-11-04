/// <reference types="vitest/config" />
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Built into dist/ and served by the server at /quest/ (same origin as /ws, /api and /sim/).
// `npm run dev:hmr -w @ce/quest` runs Vite's own dev server on :5174 with the server routes proxied.
// Shared by quest-io (index.html, src/{app,io,scan,pair,voice,replay}) and gen3d-lead (gallery.html, src/{gen3d,hud,fx}).
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const input: Record<string, string> = { main: here('./index.html'), reviewer: here('./reviewer.html'), hands: here('./hands.html') };
if (existsSync(here('./gallery.html'))) input.gallery = here('./gallery.html');

const server = 'http://127.0.0.1:8787';

export default defineConfig({
  base: '/quest/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input },
  },
  worker: { format: 'es' },
  server: {
    port: 5174,
    proxy: {
      '/api': server,
      '/sim': server,
      '/companion': server,
      '/p/': server,
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
