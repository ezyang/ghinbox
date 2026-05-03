import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for GitHub notifications webapp E2E tests.
 *
 * Each Playwright worker gets its own server instance (with a unique SQLite DB)
 * via the worker-scoped fixture in tests/fixtures.ts. This prevents cross-test
 * state contamination through the server-side store.
 *
 * The server is started with --test flag which:
 * 1. Disables live GitHub fetching (no GHSIM_ACCOUNT set)
 * 2. Enables the /health/test endpoint (returns 200 only in test mode)
 */

export default defineConfig({
  testDir: './tests',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only (reduced to 1 for faster feedback)
  retries: process.env.CI ? 1 : 0,

  // Use multiple workers on CI for faster execution
  // 50% of cores provides good parallelism while avoiding resource contention
  workers: process.env.CI ? '50%' : undefined,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],

  // Shared settings for all projects
  use: {
    // baseURL is set per-worker by the workerServer fixture in tests/fixtures.ts

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // No webServer config — each worker starts its own server via fixtures.ts

  // Output directory for test artifacts
  outputDir: 'test-results',
});
