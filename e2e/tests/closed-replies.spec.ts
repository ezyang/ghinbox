import { test, expect } from '@playwright/test';
import {
  expectHiddenNotificationIds,
  expectVisibleNotificationIds,
  openNotificationsWithCachedData,
  viewTab,
} from './app-fixture';

function notification(id: string, type: 'Issue' | 'PullRequest', number: number) {
  return {
    id,
    unread: true,
    reason: 'comment',
    updated_at: '2026-06-08T12:00:00Z',
    last_read_at: '2026-06-08T08:00:00Z',
    subject: {
      title: id,
      url: `https://github.com/test/repo/${type === 'Issue' ? 'issues' : 'pull'}/${number}`,
      type,
      number,
      state: 'closed',
      state_reason: null,
    },
    actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
    ui: { saved: false, done: false },
  };
}

function comment(id: number, login: string, createdAt: string, body: string, extra = {}) {
  return {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    body,
    user: { login },
    ...extra,
  };
}

function cachedThread(comments: unknown[], closedAt: string) {
  return {
    notificationUpdatedAt: '2026-06-08T12:00:00Z',
    lastReadAt: '2026-06-08T08:00:00Z',
    unread: true,
    allComments: true,
    fetchedAt: new Date().toISOString(),
    reviewDecision: null,
    reviewDecisionFetchedAt: new Date().toISOString(),
    comments,
    stateEvents: [
      {
        id: `closed-${closedAt}`,
        event: 'closed',
        created_at: closedAt,
      },
    ],
  };
}

test.describe('Closed Replies queue @classification', () => {
  test('hides closed issue and PR replies unless the reply is after the close event', async ({
    page,
  }) => {
    const notifications = {
      source_url: 'https://github.com/notifications?query=repo:test/repo',
      generated_at: '2026-06-08T00:00:00Z',
      repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
      notifications: [
        notification('closed-pr-before-close-reply', 'PullRequest', 10),
        notification('closed-pr-after-close-reply', 'PullRequest', 11),
        notification('closed-issue-before-close-reply', 'Issue', 12),
        notification('closed-issue-after-close-reply', 'Issue', 13),
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
        'closed-pr-before-close-reply': cachedThread(
          [
            comment(100, 'testuser', '2026-06-08T09:00:00Z', 'Could you check this?', {
              isReviewComment: true,
            }),
            comment(101, 'alice', '2026-06-08T10:00:00Z', 'Handled before close.', {
              in_reply_to_id: 100,
              isReviewComment: true,
            }),
          ],
          '2026-06-08T11:00:00Z'
        ),
        'closed-pr-after-close-reply': cachedThread(
          [
            comment(200, 'testuser', '2026-06-08T09:00:00Z', 'Could you check this?', {
              isReviewComment: true,
            }),
            comment(201, 'alice', '2026-06-08T12:00:00Z', 'I found a post-close problem.', {
              in_reply_to_id: 200,
              isReviewComment: true,
            }),
          ],
          '2026-06-08T11:00:00Z'
        ),
        'closed-issue-before-close-reply': cachedThread(
          [
            comment(300, 'testuser', '2026-06-08T09:00:00Z', 'I am looking.'),
            comment(301, 'alice', '2026-06-08T10:00:00Z', 'This was handled before close.'),
          ],
          '2026-06-08T11:00:00Z'
        ),
        'closed-issue-after-close-reply': cachedThread(
          [
            comment(400, 'testuser', '2026-06-08T09:00:00Z', 'I am looking.'),
            comment(401, 'alice', '2026-06-08T12:00:00Z', 'This still reproduces.'),
          ],
          '2026-06-08T11:00:00Z'
        ),
      },
    };

    await openNotificationsWithCachedData(page, {
      commentCache,
      expectedCount: 2,
      notifications,
    });

    await viewTab(page, 'pr-notifications').click();
    await expect(viewTab(page, 'pr-notifications').locator('.count')).toHaveText('2');
    await expectVisibleNotificationIds(page, [
      'closed-pr-after-close-reply',
      'closed-issue-after-close-reply',
    ]);
    await expectHiddenNotificationIds(page, [
      'closed-pr-before-close-reply',
      'closed-issue-before-close-reply',
    ]);
  });
});
