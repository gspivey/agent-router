import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Cap test memory on the 16GB VM shared with kirocrew + the agent-router
    // daemon. Uncapped, the forks pool starts one worker per CPU (7 on 8 CPUs)
    // at up to ~4GB RSS each, which triggered global OOM kills that also took
    // down agent-router.service (OOMPolicy=stop) and abandoned live sessions.
    // 3 forks with a 2GB old-space limit each keeps peak usage bounded, and a
    // runaway worker fails with a JS heap error instead of a kernel OOM kill.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 3,
        execArgv: ['--max-old-space-size=2048'],
      },
    },
    // Inline projects do NOT inherit the root `test` options unless they set
    // `extends: true`. Without it the pool settings above are silently ignored
    // and every project runs with the defaults.
    projects: [
      {
        extends: true,
        test: {
          name: 'tier1',
          include: ['test/tier1/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'tier2',
          include: ['test/tier2/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'tier3',
          include: ['test/tier3/**/*.test.ts'],
        },
      },
    ],
  },
});
