import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

/**
 * Playwright configuration for GitHub notifications webapp E2E tests.
 *
 * The tests run against the FastAPI server which serves:
 * - API endpoints at /notifications/html/*, /github/*
 * - Static webapp at /app/
 *
 * IMPORTANT: Test Server Architecture
 * -----------------------------------
 * By default, a random free port is allocated so multiple test runs can execute
 * concurrently without conflicts. Set TEST_PORT to override with a fixed port.
 * The test server is started with --test flag which:
 * 1. Disables live GitHub fetching (no GHINBOX_ACCOUNT set)
 * 2. Enables the /health/test endpoint (returns 200 only in test mode)
 *
 * The /health/test endpoint is the key safety mechanism:
 * - In test mode: returns 200, allowing server reuse
 * - In production mode: returns 503, forcing Playwright to start a fresh test server
 *
 * This prevents tests from accidentally connecting to a production server that
 * might be running, which would consume real GitHub API quota.
 */

// Test server port - auto-allocate a free port to allow concurrent test runs.
// Set TEST_PORT env var to override with a fixed port.
// We must set process.env.TEST_PORT so worker processes (which re-evaluate this
// config) use the same port as the main process that starts the webServer.
if (!process.env.TEST_PORT) {
  process.env.TEST_PORT = execSync(
    `node -e "const s=require('net').createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close()})"`,
    { encoding: 'utf-8' },
  ).trim();
}
const TEST_PORT = process.env.TEST_PORT;

// Per-run snapshot DB so test runs are hermetic: no state leaks between runs
// and concurrent runs don't share a database. The path is passed to the
// webServer via the environment and deleted in global-teardown (the server
// process is killed, so it cannot clean up after itself).
if (!process.env.GHINBOX_SNAPSHOT_DB_PATH) {
  process.env.GHINBOX_SNAPSHOT_DB_PATH = path.join(
    os.tmpdir(),
    `ghinbox_snapshot_e2e_${TEST_PORT}.db`,
  );
}

export default defineConfig({
  testDir: './tests',

  globalTeardown: './global-teardown.ts',

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
    command: `cd .. && GHINBOX_ACCOUNT= GHINBOX_HEADLESS= GHINBOX_NEEDS_AUTH= GHINBOX_SNAPSHOT_SYNC_INTERVAL_SECONDS=0 GHINBOX_WEBHOOK_SECRET=e2e-webhook-secret GHINBOX_WEBHOOK_REPOSITORY=ezyang/ghinbox GHINBOX_SNAPSHOT_DB_PATH=${process.env.GHINBOX_SNAPSHOT_DB_PATH} uv run python -m ghinbox.api.server --test --no-reload --no-debug-socket --port ${TEST_PORT}`,
    // CRITICAL: Use /health/test endpoint which returns 503 if server is not in test mode.
    // This prevents reusing a production server that might be running on this port.
    url: `http://localhost:${TEST_PORT}/health/test`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },

  // Output directory for test artifacts
  outputDir: 'test-results',
});
