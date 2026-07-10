import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10000,
  expect: {
    timeout: 3000,
  },
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
  },
  reporter: [['list']],
});
