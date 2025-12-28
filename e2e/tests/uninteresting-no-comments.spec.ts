import { test, expect } from '@playwright/test';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-02T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'thread-1',
      unread: true,
      reason: 'comment',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'No new comments should be uninteresting',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
  ],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

// Skip: Uninteresting filter was removed in the view-based filtering refactor
test.describe.skip('Uninteresting without new comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
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

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    const commentCache = {
      version: 1,
      threads: {
        'thread-1': {
          notificationUpdatedAt: notificationsResponse.notifications[0].updated_at,
          lastReadAt: notificationsResponse.notifications[0].last_read_at,
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [],
        },
      },
    };

    await page.addInitScript((cache) => {
      localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      localStorage.setItem('ghnotif_bulk_comment_cache_v1', JSON.stringify(cache));
    }, commentCache);

    await page.goto('notifications.html');

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('treats notifications with no new comments as uninteresting', async ({ page }) => {
    await expect(page.locator('#count-uninteresting')).toHaveText('1');
    await expect(page.locator('.comment-tag.uninteresting')).toHaveText(
      'Uninteresting (0)'
    );

    await page.locator('#filter-uninteresting').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-1"]')).toBeVisible();
  });

  test('Mark all button appears in Uninteresting tab and marks done', async ({ page }) => {
    const apiCalls: string[] = [];

    await page.route('**/github/rest/notifications/threads/**', (route) => {
      apiCalls.push(route.request().url());
      route.fulfill({ status: 204 });
    });

    await page.locator('#filter-uninteresting').click();

    const markDoneBtn = page.locator('#mark-done-btn');
    await expect(markDoneBtn).toBeVisible();
    await expect(markDoneBtn).toHaveText('Mark all as Done');

    await markDoneBtn.click();

    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
    expect(apiCalls.length).toBe(1);
    expect(apiCalls[0]).toContain('thread-1');
  });
});
