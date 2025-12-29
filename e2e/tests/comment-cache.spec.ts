import { test, expect } from '@playwright/test';
import { clearAppStorage, readCommentCache, seedCommentCache } from './storage-utils';

test.describe('Comment cache', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          login: 'testuser',
          name: 'Test User',
        }),
      });
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      });
    });
  });

  test('clear cache button removes stored comments', async ({ page }) => {
    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, {
      version: 1,
      threads: {
        '123': {
          fetchedAt: new Date().toISOString(),
          comments: [],
        },
      },
    });
    await page.reload();

    const status = page.locator('#comment-cache-status');
    const clearBtn = page.locator('#clear-comment-cache-btn');

    await expect(status).toContainText('Comments cached: 1');
    await expect(clearBtn).toBeEnabled();

    await clearBtn.click();

    await expect(status).toContainText('Comments cached: 0');
    await expect(clearBtn).toBeDisabled();

    const cachedValue = await readCommentCache(page);
    expect(cachedValue).toBeNull();
  });
});
