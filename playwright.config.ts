import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test/browser',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx scripts/browser-test-server.ts',
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
