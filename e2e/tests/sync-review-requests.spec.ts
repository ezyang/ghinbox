import { test, expect } from '@playwright/test';
import { openCleanSyncPage, syncFixtures } from './app-fixture';

const { emptyResponse } = syncFixtures;

test.describe('Sync review requests @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('sync starts review request pull before notification pages resolve', async ({ page }) => {
    let releaseNotifications!: () => void;
    const notificationsCanResolve = new Promise<void>((resolve) => {
      releaseNotifications = resolve;
    });
    let reviewRequestCalled = false;

    await page.route('**/api/snapshots/test/repo/sync', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'No GitHub fetcher configured. Start server with --account.',
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          sync: { status: 'idle', mode: 'full' },
          snapshot: null,
        }),
      });
    });

    await page.route('**/github/rest/review-requests?*', (route) => {
      reviewRequestCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notifications: [] }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo**', async (route) => {
      await notificationsCanResolve;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#profile-select').selectOption('custom');
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect.poll(() => reviewRequestCalled, { timeout: 1200 }).toBe(true);

    releaseNotifications();
    await expect(page.locator('#status-bar')).toContainText('Synced 0 notifications');
  });
});
