import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the *built* SPA served by `vite preview`.
// Run `pnpm --filter web build` first; browsers are installed separately (`playwright install`).
// `*.mock.e2e.ts` specs run against a second build with the in-browser mock hub (VITE_MOCK=1,
// src/dev/mock.ts), built into out/mock by the web server command below.
const PORT = 4173;
const MOCK_PORT = 4174;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `VITE_MOCK=1 pnpm exec vite build --outDir out/mock --emptyOutDir --logLevel warn && pnpm exec vite preview --outDir out/mock --host 127.0.0.1 --port ${MOCK_PORT} --strictPort`,
      url: `http://127.0.0.1:${MOCK_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/*.mock.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mock',
      testMatch: '**/*.mock.e2e.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${MOCK_PORT}` },
    },
  ],
});
