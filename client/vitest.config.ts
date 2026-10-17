import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirror the production `__APP_VERSION__` define (spa-polish ROADMAP 88) so the
// Header component resolves it under the test runner the same way the Vite build
// does. Read from client/package.json, identical to vite.config.ts.
const pkgVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string;

export default defineConfig({
  plugins: [svelte()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  resolve: {
    alias: {
      '@shared/logic': path.resolve(__dirname, '../src/ui/logic.ts'),
    },
    // Use the browser build of Svelte so component tests mount against the DOM.
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
