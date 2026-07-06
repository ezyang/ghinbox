import { test, expect } from '@playwright/test';
import { openCleanSyncPage, syncFixtures } from './app-fixture';
import { readNotificationsCache } from './storage-utils';

const { emptyResponse, mixedResponse } = syncFixtures;

test.describe('Sync Basic @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('sync button triggers API call', async ({ page }) => {
    let apiCalled = false;

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      apiCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');
    expect(apiCalled).toBe(true);
  });

  test('sync fetches notifications and displays count @smoke', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    await expect(page.locator('#notification-count')).toContainText('4 notifications');
    await expect(page.locator('#notifications-list li').first()).toHaveAttribute(
      'data-id',
      'notif-1'
    );
  });

  test('session-expired sync response redirects to login refresh', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            error: 'session_expired',
            message: 'GitHub session has expired. Please re-authenticate.',
          },
        }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Session expired');
    await expect(page).toHaveURL(/\/app\/login\.html\?session_refresh=1/);
  });

  test('sync stores notifications in IndexedDB', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    const stored = await readNotificationsCache(page);

    expect(Array.isArray(stored)).toBe(true);
    if (Array.isArray(stored)) {
      expect(stored.length).toBe(5);
      expect(stored[0].subject.title).toBe('Fix critical bug in authentication');
    }
  });

  test('notifications persist across page reload', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');

    const storedBefore = await readNotificationsCache(page);
    expect(Array.isArray(storedBefore)).toBe(true);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#notification-count')).toContainText('4 notifications');
    await expect(page.locator('#empty-state')).not.toBeVisible();
  });

  test('sync shows loading state', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#loading')).toBeVisible();
    await expect(page.locator('#status-bar')).toContainText('Synced');
    await expect(page.locator('#loading')).not.toBeVisible();
  });

  test('sync shows progress status', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toBeVisible();
  });

  test('sync avoids detailed request log status while loading', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Quick Sync in progress');
    await expect(statusBar).not.toContainText('requesting page 1');
    await expect(statusBar).toContainText('Synced');
    await expect(statusBar).toHaveClass(/auto-dismiss/);
  });

  test('sync hides empty state when notifications exist', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedResponse),
      });
    });

    await expect(page.locator('#empty-state')).toBeVisible();

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced');
    await expect(page.locator('#empty-state')).not.toBeVisible();
  });

  test('sync shows empty state when no notifications', async ({ page }) => {
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 0 notifications');
    await expect(page.locator('#empty-state')).toBeVisible();
  });
});
