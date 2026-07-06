import { test, expect } from '@playwright/test';
import { openCleanSyncPage, syncFixtures } from './app-fixture';

const { mixedResponse } = syncFixtures;

test.describe('Sync Errors @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('shows error on API failure', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal server error' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('shows error on network failure', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.abort('failed');
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('shows specific error message from API', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Failed to fetch from GitHub: timeout' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('timeout');
  });

  test('links expired browser-session full sync errors to login', async ({ page }) => {
    const expiredMessage =
      'GitHub redirected notifications request to login. Stored browser session is expired.';

    await page.route('**/api/snapshots/test/repo/sync', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          sync: {
            status: route.request().method() === 'POST' ? 'running' : 'error',
            mode: 'full',
            error: expiredMessage,
          },
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText(`Full Sync failed: ${expiredMessage}`);
    await expect(statusBar.getByRole('link', { name: 'Log in again' })).toHaveAttribute(
      'href',
      'login.html?session_refresh=1'
    );
  });

  test('keeps error status visible when message text is clicked', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          detail:
            'It looks like you are using Playwright Sync API inside the asyncio loop. Please use the Async API instead.',
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Playwright Sync API inside the asyncio loop');
    await expect(statusBar.locator('.status-close-btn')).toBeVisible();

    await statusBar.locator('.status-message').click();
    await expect(statusBar).toContainText('Playwright Sync API inside the asyncio loop');

    await statusBar.locator('.status-close-btn').click();
    await expect(statusBar).not.toBeVisible();
  });

  test('loading state is hidden after error', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Error' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#loading')).not.toBeVisible();
  });

  test('preserves existing notifications on sync error', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 5');

    await page.unroute('**/notifications/html/repo/test/repo');
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Error' }),
      });
    });

    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Sync failed');
    await expect(page.locator('#notification-count')).toContainText('4 notifications');
  });
});
