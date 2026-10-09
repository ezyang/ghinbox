import { test, expect } from '@playwright/test';
import {
  expectHiddenNotificationIds,
  expectVisibleNotificationIds,
  makeNotification,
  makeNotificationsResponse,
  openNotificationsWithCachedData,
  viewTab,
} from './app-fixture';

function makeClosedNotification(
  id: string,
  type: 'Issue' | 'PullRequest',
  number: number,
  reason = 'comment'
) {
  return makeNotification({
    id,
    reason,
    updated_at: '2026-06-08T12:00:00Z',
    last_read_at: '2026-06-08T08:00:00Z',
    subject: {
      title: id,
      type,
      number,
      state: 'closed',
    },
    actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
  });
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
  test('hides a closed PR reply unless it is after the close event', async ({
    page,
  }) => {
    const notifications = makeNotificationsResponse(
      [
        makeClosedNotification('closed-pr-before-close-reply', 'PullRequest', 10),
        makeClosedNotification('closed-pr-after-close-reply', 'PullRequest', 11),
      ],
      { generated_at: '2026-06-08T00:00:00Z' }
    );
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
      },
    };

    await openNotificationsWithCachedData(page, {
      commentCache,
      expectedCount: 1,
      notifications,
    });

    await viewTab(page, 'pr-notifications').click();
    await expect(viewTab(page, 'pr-notifications').locator('.count')).toHaveText('1');
    await expectVisibleNotificationIds(page, ['closed-pr-after-close-reply']);
    await expectHiddenNotificationIds(page, ['closed-pr-before-close-reply']);
  });

  test('surfaces a comment on my closed PR made after it closed', async ({ page }) => {
    const notifications = makeNotificationsResponse(
      [
        makeClosedNotification('my-closed-pr-comment-after-close', 'PullRequest', 20, 'author'),
        makeClosedNotification('my-closed-pr-comment-before-close', 'PullRequest', 21, 'author'),
        makeClosedNotification('my-closed-pr-bot-after-close', 'PullRequest', 22, 'author'),
      ],
      { generated_at: '2026-06-08T00:00:00Z' }
    );
    const commentCache = {
      version: 1,
      threads: {
        'my-closed-pr-comment-after-close': cachedThread(
          [comment(300, 'alice', '2026-06-08T12:00:00Z', 'This broke my build, can you take a look?')],
          '2026-06-08T11:00:00Z'
        ),
        'my-closed-pr-comment-before-close': cachedThread(
          [comment(310, 'alice', '2026-06-08T10:00:00Z', 'Superseded by another PR.')],
          '2026-06-08T11:00:00Z'
        ),
        'my-closed-pr-bot-after-close': cachedThread(
          [comment(320, 'pytorchbot', '2026-06-08T12:00:00Z', 'Stale PR cleanup.')],
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
    await expect(viewTab(page, 'pr-notifications').locator('.count')).toHaveText('1');
    await expectVisibleNotificationIds(page, ['my-closed-pr-comment-after-close']);
    await expectHiddenNotificationIds(page, [
      'my-closed-pr-comment-before-close',
      'my-closed-pr-bot-after-close',
    ]);
  });
});
