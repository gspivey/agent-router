import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Use vmThreads pool to share a single V8 isolate across workers,
    // significantly reducing per-worker memory overhead vs the default
    // forks pool. Cap at 4 workers: on the 16GB VM with kirocrew + agent-router
    // using ~2GB baseline, uncapped vmThreads (7 workers on 8 CPUs) still hit
    // 3.5GB anon RSS and triggered OOM kills. 4 workers keeps peak below ~2GB
    // while keeping the suite parallel. Increase if the VM gets more RAM.
    pool: 'vmThreads',
    poolOptions: {
      vmThreads: {
        maxThreads: 4,
      },
    },
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
