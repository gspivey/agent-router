import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-time app version, read from client/package.json so the header can show
// it via the `__APP_VERSION__` define (spa-polish ROADMAP 87, Req 7.1).
const pkgVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string;

// The daemon's control port. Supplied via env in dev so the Vite proxy can
// forward API/SSE calls back to the running daemon.
const CONTROL_PORT = process.env.CONTROL_PORT ?? '8787';
const target = `http://localhost:${CONTROL_PORT}`;

export default defineConfig({
  // Assets are referenced under /app/ to match the daemon mount (CRITICAL-1).
  base: '/app/',
  // Expose the client package version as a build-time constant (Req 7.1).
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
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
      '/overview': { target, changeOrigin: true },
    },
  },
});
