import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Use vmThreads pool to share a single V8 isolate across workers,
    // significantly reducing per-worker memory overhead vs the default
    // forks pool. Prevents OOM kills when running 140+ test files in
    // parallel on the 16GB VM (observed: forks used 2-3 GB anon RSS per run).
    pool: 'vmThreads',
    projects: [
      {
        test: {
          name: 'tier1',
          include: ['test/tier1/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'tier2',
          include: ['test/tier2/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'tier3',
          include: ['test/tier3/**/*.test.ts'],
        },
      },
    ],
  },
});
