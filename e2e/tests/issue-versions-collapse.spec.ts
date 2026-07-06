import { test, expect } from '@playwright/test';
import { openNotificationsWithCommentCache } from './app-fixture';

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

test.describe('Issue versions section @layout', () => {
  test.beforeEach(async ({ page }) => {
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

    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
    });
    await openNotificationsWithCommentCache(page, {
      commentCache,
      expectedCount: 1,
      notifications: notificationsResponse,
    });
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
