import { test, expect } from '@playwright/test';
import { clearAppStorage } from './storage-utils';

const notifications = [
  {
    id: 'thread-1',
    unread: true,
    reason: 'subscribed',
    updated_at: '2025-01-02T00:00:00Z',
    last_read_at: null,
    subject: {
      title: 'Prefetch issue 1',
      url: 'https://github.com/test/repo/issues/1',
      type: 'Issue',
      number: 1,
      state: 'open',
      state_reason: null,
    },
    actors: [],
    ui: { saved: false, done: false },
  },
  {
    id: 'thread-2',
    unread: true,
    reason: 'subscribed',
    updated_at: '2025-01-02T00:00:00Z',
    last_read_at: null,
    subject: {
      title: 'Prefetch issue 2',
      url: 'https://github.com/test/repo/issues/2',
      type: 'Issue',
      number: 2,
      state: 'open',
      state_reason: null,
    },
    actors: [],
    ui: { saved: false, done: false },
  },
];

test.describe('Comment prefetch status', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rate: { limit: 5000, remaining: 4999, reset: 0 },
          resources: {},
        }),
      });
    });

    await page.route(
      '**/github/rest/repos/test/repo/issues/*/comments',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }
    );

    await page.route('**/github/rest/repos/test/repo/issues/*', (route) => {
      if (route.request().url().includes('/comments')) {
        route.fallback();
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 101,
          number: 1,
          user: { login: 'author' },
          body: 'Issue body',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
      if (typeof checkAuth === 'function') {
        checkAuth();
      }
    });
  });

  test('keeps the prefetch status visible during background work', async ({
    page,
  }) => {
    await page.waitForFunction(
      () => typeof scheduleCommentPrefetch === 'function'
    );

    await page.evaluate((pending) => {
      state.repo = 'test/repo';
      state.commentCache = { version: 1, threads: {} };
      scheduleCommentPrefetch(pending);
    }, notifications);

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Prefetch:');
    await page.waitForTimeout(800);
    await expect(statusBar).toContainText('Prefetch:');
    await expect(statusBar).toBeVisible();
  });
});
