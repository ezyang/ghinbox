import { test, expect } from '@playwright/test';
import {
  makeCommentCache,
  makeCommentThread,
  makeNotification,
  makeNotificationsResponse,
  openNotificationsWithCommentCache,
  viewTab,
} from './app-fixture';

// GitHub points a PR notification whose latest event is a push at the
// "changes since you last looked" compare page. In Replies that page hides
// the reply that put the PR there, so the row links to the reply instead.
const pushedPr = makeNotification({
  id: 'thread-pushed-pr',
  reason: 'review_requested',
  subject: {
    title: 'PR with a reply and a later push',
    number: 3,
    url: 'https://github.com/test/repo/pull/3/changes/1111111111111111111111111111111111111111..2222222222222222222222222222222222222222?notification_referrer_id=NT_x',
  },
});

const replyUrl = 'https://github.com/test/repo/pull/3#issuecomment-555';

test.describe('Reply links @classification', () => {
  test('Replies row for a pushed PR links to the reply, not the compare page', async ({ page }) => {
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([pushedPr]),
      commentCache: makeCommentCache({
        'thread-pushed-pr': makeCommentThread({
          allComments: true,
          comments: [
            {
              id: 554,
              user: { login: 'testuser' },
              body: 'test fails look real',
              created_at: '2025-01-01T06:00:00Z',
              html_url: 'https://github.com/test/repo/pull/3#issuecomment-554',
            },
            {
              id: 555,
              user: { login: 'alice' },
              body: '@testuser fixed the failures, PTAL',
              created_at: '2025-01-01T12:00:00Z',
              html_url: replyUrl,
            },
          ],
        }),
      }),
      expectedCount: 1,
    });

    await viewTab(page, 'pr-notifications').click();
    const title = page.locator('[data-id="thread-pushed-pr"] .notification-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute('href', replyUrl);
  });
});
