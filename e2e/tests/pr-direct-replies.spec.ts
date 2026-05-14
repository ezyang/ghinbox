import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-06T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'thread-pr-direct-reply',
      unread: true,
      reason: 'comment',
      updated_at: '2025-01-06T12:00:00Z',
      last_read_at: '2025-01-06T08:00:00Z',
      subject: {
        title: 'Inline response PR',
        url: 'https://github.com/test/repo/pull/20',
        type: 'PullRequest',
        number: 20,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
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

const commentCache = {
  version: 1,
  threads: {
    'thread-pr-direct-reply': {
      notificationUpdatedAt: '2025-01-06T12:00:00Z',
      lastReadAt: '2025-01-06T08:00:00Z',
      unread: true,
      allComments: true,
      fetchedAt: new Date().toISOString(),
      reviewDecision: null,
      reviewDecisionFetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 100,
          isReviewComment: true,
          path: 'src/app.py',
          line: 12,
          created_at: '2025-01-06T09:00:00Z',
          updated_at: '2025-01-06T09:00:00Z',
          body: 'Could we simplify this branch?',
          user: { login: 'testuser' },
        },
        {
          id: 101,
          in_reply_to_id: 100,
          isReviewComment: true,
          path: 'src/app.py',
          line: 12,
          created_at: '2025-01-06T10:00:00Z',
          updated_at: '2025-01-06T10:00:00Z',
          body: 'I pushed a simplification here.',
          user: { login: 'alice' },
        },
        {
          id: 200,
          isReviewComment: true,
          path: 'src/other.py',
          line: 4,
          created_at: '2025-01-06T11:00:00Z',
          updated_at: '2025-01-06T11:00:00Z',
          body: 'Separate note on another thread.',
          user: { login: 'testuser' },
        },
      ],
    },
  },
};

test.describe('PR direct replies', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

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

    await page.route('**/github/rest/search/issues**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2025-01-06T00:00:00Z',
            },
            repository: {
              pr20: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, commentCache);
    await page.reload();
  });

  test('surfaces replies on inline review threads the user participated in', async ({
    page,
  }) => {
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');

    await page.locator('#view-pr-notifications').click();
    const item = page.locator('[data-id="thread-pr-direct-reply"]');
    await expect(item.locator('.comment-tag')).toHaveText('Reply to you');
    await expect(item.locator('.comment-item')).toHaveCount(1);
    await expect(item.locator('.comment-item')).toContainText('I pushed a simplification here.');
    await expect(item.locator('.comment-item')).not.toContainText('Separate note on another thread.');
  });
});
