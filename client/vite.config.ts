import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The daemon's control port. Supplied via env in dev so the Vite proxy can
// forward API/SSE calls back to the running daemon.
const CONTROL_PORT = process.env.CONTROL_PORT ?? '8787';
const target = `http://localhost:${CONTROL_PORT}`;

export default defineConfig({
  // Assets are referenced under /app/ to match the daemon mount (CRITICAL-1).
  base: '/app/',
  plugins: [svelte()],
  resolve: {
    alias: {
      // The ONLY cross-directory import: the pure, DOM-free shared logic module.
      '@shared/logic': path.resolve(__dirname, '../src/ui/logic.ts'),
    },
  },
  server: {
    // Let Vite serve ../src/ui/logic.ts (outside the client/ root) in dev (HIGH-3).
    fs: { allow: ['..'] },
    port: 5174,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1'],
    // Separate HMR socket so it never collides with the proxied /sessions stream.
    hmr: { port: 5175 },
    proxy: {
      '/api': { target, changeOrigin: true },
      '/sessions': { target, changeOrigin: true, ws: true },
      '/repos': { target, changeOrigin: true },
      '/projects': { target, changeOrigin: true },
      '/config': { target, changeOrigin: true },
    },
  },
});
