import { defineConfig, devices } from '@playwright/test';

// deploy/e2e/stack.sh starts the CI stack (db, api, ssr, caddy, a TLS edge) and runs Playwright inside the
// pinned image mcr.microsoft.com/playwright:v1.64.1-noble on its network, with E2E_BASE_URL=https://mjk.test.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('E2E_BASE_URL is required: run deploy/e2e/stack.sh');

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  // The edge's certificate comes from Caddy's internal CA.
  use: { baseURL, ignoreHTTPSErrors: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
