import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', timeout: 60000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, viewport: { width: 1440, height: 1100 }, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 30000, env: { ...process.env, RINGMAPPER_SKIP_LOGIN: '1' } }
});
