import { test, expect } from '@playwright/test';

test.describe('Rate limit explain logs', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });

    const resetBase = Math.floor(Date.now() / 1000) + 3600;

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: resetBase,
            },
          },
        }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              remaining: 4999,
              limit: 5000,
              resetAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
  });

  test('shows request log details when Explain is clicked', async ({ page }) => {
    await page.locator('#rate-limit-explain-btn').click();

    await expect(page.locator('#rate-limit-details')).toBeVisible();
    await expect(page.locator('#rate-limit-log-status')).toContainText('Logged');
    // Only 1 call on init: /rate_limit; graphql rate limit call is skipped to save rate limit
    await expect(page.locator('#rate-limit-log li')).toHaveCount(1);

    const log = page.locator('#rate-limit-log');
    await expect(log).toContainText('/github/rest/rate_limit');
  });
});

test.describe('Rate limit log reset', () => {
  test('clears old entries when core reset changes', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });

    let resetBase = Math.floor(Date.now() / 1000) + 3600;
    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: resetBase,
            },
          },
        }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              remaining: 4999,
              limit: 5000,
              resetAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await page.locator('#rate-limit-explain-btn').click();
    await expect(page.locator('#rate-limit-log')).not.toContainText('/github/rest/user');

    resetBase += 3600;
    await page.evaluate(() => refreshRateLimit());

    await expect(page.locator('#rate-limit-log')).toContainText('/github/rest/rate_limit');
  });
});
