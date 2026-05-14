import { test, expect } from '@playwright/test';
import { clearAppStorage, readNotificationsCache } from './storage-utils';

const initialNotifications = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-02T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'thread-pr-1',
      unread: true,
      reason: 'review_requested',
      updated_at: '2025-01-03T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Primary PR',
        url: 'https://github.com/test/repo/pull/1',
        type: 'PullRequest',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    {
      id: 'thread-pr-2',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Cached PR',
        url: 'https://github.com/test/repo/pull/2',
        type: 'PullRequest',
        number: 2,
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

const quickSyncNotifications = {
  ...initialNotifications,
  notifications: [initialNotifications.notifications[0]],
};

test.describe('Quick Sync PR state refresh @slow @sync', () => {
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

    let notificationsCallCount = 0;
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      notificationsCallCount += 1;
      const payload =
        notificationsCallCount === 1 ? initialNotifications : quickSyncNotifications;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.route('**/github/graphql', async (route) => {
      const request = route.request();
      const body = request.postData() || '{}';
      const parsed = JSON.parse(body);
      const query = parsed.query || '';
      const matches = Array.from(query.matchAll(/pullRequest\(number:\s*(\d+)\)/g));
      const repository: Record<string, unknown> = {};
      matches.forEach((match) => {
        const issueNumber = Number(match[1]);
        repository[`pr${issueNumber}`] = {
          state: issueNumber === 2 ? 'CLOSED' : 'OPEN',
          isDraft: false,
        };
      });
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: new Date().toISOString(),
            },
            repository,
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('updates cached PR state after quick sync', async ({ page }) => {
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect
      .poll(async () => {
        const cached = await readNotificationsCache(page);
        return Array.isArray(cached) ? cached.length : 0;
      })
      .toBe(2);

    await page.locator('#sync-btn').click();
    await expect
      .poll(async () => {
        const cached = await readNotificationsCache(page);
        if (!Array.isArray(cached)) {
          return null;
        }
        const target = cached.find((notif) => notif.id === 'thread-pr-2');
        return target?.subject?.state || null;
      })
      .toBe('closed');
  });
});
