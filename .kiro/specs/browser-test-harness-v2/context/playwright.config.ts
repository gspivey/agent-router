import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'on-first-retry',
  },
});
