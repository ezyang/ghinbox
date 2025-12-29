import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for GitHub notifications webapp E2E tests.
 *
 * The tests run against the FastAPI server which serves:
 * - API endpoints at /notifications/html/*, /github/*
 * - Static webapp at /app/
 *
 * IMPORTANT: Test Server Architecture
 * -----------------------------------
 * Tests use port 8001 by default (not 8000) to avoid conflicts with production servers.
 * The test server is started with --test flag which:
 * 1. Disables live GitHub fetching (no GHSIM_ACCOUNT set)
 * 2. Enables the /health/test endpoint (returns 200 only in test mode)
 *
 * The /health/test endpoint is the key safety mechanism:
 * - In test mode: returns 200, allowing server reuse
 * - In production mode: returns 503, forcing Playwright to start a fresh test server
 *
 * This prevents tests from accidentally connecting to a production server that
 * might be running, which would consume real GitHub API quota.
 */

// Test server port - use 8001 to avoid conflicts with production servers on 8000
const TEST_PORT = process.env.TEST_PORT || '8001';

export default defineConfig({
  testDir: './tests',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI for stability
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],

  // Shared settings for all projects
  use: {
    // Base URL for the webapp (using test port)
    baseURL: `http://localhost:${TEST_PORT}/app/`,

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

  // Run local dev server before starting the tests
  webServer: {
    command: `cd .. && uv run python -m ghinbox.api.server --test --no-reload --port ${TEST_PORT}`,
    // CRITICAL: Use /health/test endpoint which returns 503 if server is not in test mode.
    // This prevents reusing a production server that might be running on this port.
    url: `http://localhost:${TEST_PORT}/health/test`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },

  // Output directory for test artifacts
  outputDir: 'test-results',
});
