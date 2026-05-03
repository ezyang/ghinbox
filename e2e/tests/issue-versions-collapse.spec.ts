import { test, expect } from './fixtures';
import { clearAppStorage, seedCommentCache } from './storage-utils';

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
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Versioned issue',
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

test.describe('Issue versions section', () => {
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
          allComments: true,
          fetchedAt: new Date().toISOString(),
          comments: [
            {
              id: 201,
              user: { login: 'issue-author' },
              body: [
                '# Versions',
                '',
                '- 1.2.3',
                '- 2.0.0',
                '',
                '## Notes',
                '',
                'Extra context.',
              ].join('\n'),
              created_at: '2025-01-01T01:00:00Z',
              updated_at: '2025-01-01T01:00:00Z',
            },
          ],
        },
      },
    };

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
    });
    await seedCommentCache(page, commentCache);
    await page.reload();

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('collapses versions section by default', async ({ page }) => {
    const details = page.locator('.comment-body details.collapsed-versions');
    await expect(details).toHaveCount(1);
    await expect(details.locator('summary')).toHaveText('Versions');
    await expect(details).toHaveJSProperty('open', false);
    await expect(details).toContainText('1.2.3');
  });
});
