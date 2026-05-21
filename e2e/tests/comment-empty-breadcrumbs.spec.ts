import { test, expect } from '@playwright/test';
import { openNotificationsWithCachedData } from './app-fixture';

const notification = {
  id: 'thread-own-latest',
  unread: true,
  reason: 'comment',
  updated_at: '2025-01-02T00:00:00Z',
  last_read_at: null,
  subject: {
    title: 'Comment breadcrumb check',
    url: 'https://github.com/test/repo/issues/1',
    type: 'Issue',
    number: 1,
    state: 'open',
    state_reason: null,
  },
  actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
  ui: { saved: false, done: false },
};

test.describe('Comment empty breadcrumbs @layout', () => {
  test('explains when cached comments are hidden after the latest own comment', async ({
    page,
  }) => {
    await openNotificationsWithCachedData(page, {
      expectedCount: 1,
      notifications: {
        source_url: 'https://github.com/notifications?query=repo:test/repo',
        generated_at: '2025-01-02T00:00:00Z',
        repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
        notifications: [notification],
        pagination: {
          before_cursor: null,
          after_cursor: null,
          has_previous: false,
          has_next: false,
        },
      },
      commentCache: {
        version: 1,
        threads: {
          'thread-own-latest': {
            notificationUpdatedAt: notification.updated_at,
            lastReadAt: null,
            unread: true,
            allComments: true,
            fetchedAt: new Date().toISOString(),
            comments: [
              {
                id: 101,
                user: { login: 'alice' },
                body: 'Can you take a look?',
                created_at: '2025-01-01T01:00:00Z',
                updated_at: '2025-01-01T01:00:00Z',
              },
              {
                id: 102,
                user: { login: 'testuser' },
                body: 'Looking now.',
                created_at: '2025-01-01T02:00:00Z',
                updated_at: '2025-01-01T02:00:00Z',
              },
            ],
          },
        },
      },
    });

    const emptyComment = page.locator('[data-id="thread-own-latest"] .comment-item');
    await expect(emptyComment).toContainText('No comments found.');
    await expect(emptyComment.locator('.comment-empty-detail')).toContainText(
      'Cached 2 comments; none remain after your latest comment.'
    );
  });
});
