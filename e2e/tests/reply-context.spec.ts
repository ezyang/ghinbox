import { test, expect } from '@playwright/test';
import {
  makeCommentCache,
  makeCommentThread,
  makeNotification,
  makeNotificationsResponse,
  openNotificationsWithCommentCache,
  viewTab,
} from './app-fixture';

// Replies rows show, inline, the comment that put them in Replies and all
// activity after it, so the user can tell whether a reply still needs them.
// Feed rows show no comments. Which comments appear is table-tested in
// e2e/unit/comment-window.test.js; this pins the DOM wiring.
const reply = makeNotification({
  id: 'thread-reply',
  reason: 'mention',
  subject: { type: 'Issue', number: 7, title: 'Issue with a mention' },
});
const feed = makeNotification({
  id: 'thread-feed',
  subject: { type: 'Issue', number: 8, title: 'Issue nobody asked me about' },
});

const mentionUrl = 'https://github.com/test/repo/issues/7#issuecomment-702';

test.describe('Reply context @classification', () => {
  test('Replies row shows the reply and everything after it', async ({ page }) => {
    await openNotificationsWithCommentCache(page, {
      notifications: makeNotificationsResponse([reply, feed]),
      commentCache: makeCommentCache({
        'thread-reply': makeCommentThread({
          allComments: true,
          comments: [
            {
              id: 701,
              user: { login: 'alice' },
              body: 'Earlier background I already read',
              created_at: '2024-12-31T12:00:00Z',
            },
            {
              id: 702,
              user: { login: 'bob' },
              body: '@testuser could you route this to a reviewer?',
              created_at: '2025-01-01T06:00:00Z',
              html_url: mentionUrl,
            },
            {
              id: 703,
              user: { login: 'github-actions[bot]' },
              body: '<!-- lint -->Lint failed',
              created_at: '2025-01-01T07:00:00Z',
            },
            {
              id: 704,
              user: { login: 'pytorch-bot[bot]' },
              body: 'Needs a release notes label',
              created_at: '2025-01-01T08:00:00Z',
            },
            {
              id: 705,
              user: { login: 'carol' },
              body: 'Never mind, I will review it',
              created_at: '2025-01-01T09:00:00Z',
            },
          ],
        }),
        'thread-feed': makeCommentThread({
          allComments: true,
          comments: [
            {
              id: 801,
              user: { login: 'dave' },
              body: 'Some ambient discussion',
              created_at: '2025-01-01T06:00:00Z',
            },
          ],
        }),
      }),
      expectedCount: 2,
    });

    await expect(page.locator('[data-id="thread-feed"] .reply-context')).toHaveCount(0);

    await viewTab(page, 'pr-notifications').click();
    const context = page.locator('[data-id="thread-reply"] .reply-context');
    const items = context.locator('> li');
    await expect(items).toHaveCount(3);

    const directed = items.nth(0);
    await expect(directed).toHaveClass(/directed/);
    await expect(directed.locator('.reply-context-author')).toHaveText('bob');
    await expect(directed.locator('.reply-context-time')).toHaveAttribute('href', mentionUrl);
    await expect(directed.locator('.reply-context-body')).toHaveText(
      '@testuser could you route this to a reviewer?'
    );

    await expect(items.nth(1)).toHaveClass(/reply-context-bots/);
    await expect(items.nth(1)).toHaveText(
      '2 bot comments: github-actions[bot], pytorch-bot[bot]'
    );

    await expect(items.nth(2)).not.toHaveClass(/directed/);
    await expect(items.nth(2).locator('.reply-context-author')).toHaveText('carol');
    await expect(items.nth(2).locator('.reply-context-body')).toHaveText(
      'Never mind, I will review it'
    );
    await expect(context).not.toContainText('Earlier background');
  });
});
