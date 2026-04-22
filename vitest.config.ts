import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
