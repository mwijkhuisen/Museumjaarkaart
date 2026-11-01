import { defineConfig, devices } from '@playwright/test';

// CI starts the smoke server on the runner (Node 26) and runs Playwright inside the pinned image
// mcr.microsoft.com/playwright:v1.64.1-noble with `--network host` and E2E_BASE_URL.
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: 'node e2e/server.ts',
          cwd: new URL('..', import.meta.url).pathname,
          url: 'http://127.0.0.1:4173/healthz',
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
