import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
      });
    });

    const commentCache = {
      version: 1,
      threads: {
        'notif-2': {
          notificationUpdatedAt: mixedFixture.notifications[1].updated_at,
          lastReadAt: mixedFixture.notifications[1].last_read_at || null,
          unread: true,
          allComments: true,
          fetchedAt: new Date().toISOString(),
          comments: [],
          reviews: [
            {
              user: { login: 'reviewer' },
              state: 'APPROVED',
              submitted_at: '2024-12-27T11:00:00Z',
            },
          ],
        },
      },
    };

    await page.addInitScript(
      ({ cacheKey, prefetchKey, cacheValue }) => {
        localStorage.setItem(cacheKey, JSON.stringify(cacheValue));
        localStorage.setItem(prefetchKey, 'true');
      },
      {
        cacheKey: 'ghnotif_bulk_comment_cache_v1',
        prefetchKey: 'ghnotif_comment_prefetch_enabled',
        cacheValue: commentCache,
      }
    );

    await page.goto('notifications.html');

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
  });

  test('j/k moves the active selection', async ({ page }) => {
    await page.keyboard.press('j');

    await expect(page.locator('.notification-item').first()).toHaveClass(/keyboard-selected/);
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(1);

    await page.keyboard.press('j');
    await expect(page.locator('.notification-item').nth(1)).toHaveClass(/keyboard-selected/);
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(1);

    await page.keyboard.press('k');
    await expect(page.locator('.notification-item').first()).toHaveClass(/keyboard-selected/);
  });

  test('e marks the active notification as done', async ({ page }) => {
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204 });
    });

    await page.keyboard.press('j');
    await page.keyboard.press('e');

    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
    await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/tombstone/);
  });

  test('m unsubscribes the active approved notification', async ({ page }) => {
    await page.route(
      '**/github/rest/notifications/threads/**/subscription',
      (route) => {
        route.fulfill({ status: 204 });
      }
    );
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204 });
    });

    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('m');

    await expect(page.locator('#status-bar')).toContainText(
      'Unsubscribed and marked 1 notification as done'
    );
    await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
  });
});
