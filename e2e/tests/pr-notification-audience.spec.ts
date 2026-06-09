import { test, expect } from '@playwright/test';
import { mockDefaultApiRoutes } from './app-fixture';
import { addAuthCacheInitScript, clearAppStorage, seedCommentCache } from './storage-utils';

const makePrNotification = (id: string, number: number, title: string) => ({
  id,
  unread: true,
  reason: 'comment',
  updated_at: '2025-01-07T12:00:00Z',
  last_read_at: '2025-01-07T08:00:00Z',
  subject: {
    title,
    url: `https://github.com/test/repo/pull/${number}`,
    type: 'PullRequest',
    number,
    state: 'open',
    state_reason: null,
  },
  actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
  ui: { saved: false, done: false, action_tokens: { archive: 'archive-token', unsubscribe: 'unsubscribe-token' } },
});

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-07T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    makePrNotification('own-pr', 10, 'Own PR update'),
    makePrNotification('mentioned-pr', 11, 'Mentioned PR update'),
    makePrNotification('reply-pr', 12, 'Inline reply update'),
    makePrNotification('others-pr', 13, 'Unrelated PR update'),
    makePrNotification('pr-main-thread-chatter', 14, 'Top-level PR discussion after my comment'),
    makePrNotification('own-pr-review-comment', 15, 'Own PR inline review comment'),
  ],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

const freshIso = new Date().toISOString();
const commentCache = {
  version: 1,
  threads: {
    'own-pr': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'testuser',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 100,
          created_at: '2025-01-07T10:00:00Z',
          body: 'Update for the author.',
          user: { login: 'alice' },
        },
      ],
    },
    'mentioned-pr': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 110,
          created_at: '2025-01-07T10:00:00Z',
          body: '@testuser can you check this edge case?',
          user: { login: 'bob' },
        },
      ],
    },
    'reply-pr': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 120,
          isReviewComment: true,
          path: 'src/app.py',
          line: 4,
          created_at: '2025-01-07T09:00:00Z',
          body: 'Please simplify this.',
          user: { login: 'testuser' },
        },
        {
          id: 121,
          in_reply_to_id: 120,
          isReviewComment: true,
          path: 'src/app.py',
          line: 4,
          created_at: '2025-01-07T10:00:00Z',
          body: 'Simplified in the latest push.',
          user: { login: 'alice' },
        },
      ],
    },
    'others-pr': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 130,
          created_at: '2025-01-07T10:00:00Z',
          body: 'General update for reviewers.',
          user: { login: 'bob' },
        },
      ],
    },
    'own-pr-review-comment': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'testuser',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 150,
          isReviewComment: true,
          path: 'torch/utils/checkpoint.py',
          line: 345,
          original_line: 345,
          created_at: '2025-01-07T10:00:00Z',
          body: 'Is the main point of this to filter out the default values?',
          user: { login: 'soulitzer' },
        },
      ],
    },
    'pr-main-thread-chatter': {
      notificationUpdatedAt: '2025-01-07T12:00:00Z',
      lastReadAt: '2025-01-07T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 140,
          created_at: '2025-01-07T09:00:00Z',
          body: 'Some tests would be nice.',
          user: { login: 'testuser' },
        },
        {
          id: 141,
          created_at: '2025-01-07T10:00:00Z',
          body: 'I checked the runtime estimation path.',
          user: { login: 'bob' },
        },
      ],
    },
  },
};

test.describe('Replies queue classification @classification', () => {
  test.beforeEach(async ({ page }) => {
    await addAuthCacheInitScript(page);
    await mockDefaultApiRoutes(page, { notifications: notificationsResponse });

    await page.unroute('**/github/graphql').catch(() => undefined);
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2025-01-07T00:00:00Z',
            },
            repository: {
              pr10: {
                reviewDecision: null,
                authorAssociation: 'OWNER',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'testuser' },
              },
              pr11: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
              pr12: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
              pr13: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
              pr14: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
              pr15: {
                reviewDecision: null,
                authorAssociation: 'OWNER',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'testuser' },
              },
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_comment_expand_prs', 'true');
    });
    await seedCommentCache(page, commentCache);
    await page.reload();
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 6 notifications');
    await page.locator('#view-pr-notifications').click();
  });

  test('shows directed PR mentions and thread replies in Replies', async ({ page }) => {
    await expect(page.locator('#view-issues .count')).toHaveText('2');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('4');
    await expect(page.locator('#view-others-prs .count')).toHaveText('0');
    await expect(page.locator('.notification-item')).toHaveCount(4);

    await expect(page.locator('[data-id="own-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="mentioned-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="reply-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="own-pr-review-comment"]')).toBeVisible();
    await expect(page.locator('[data-id="others-pr"]')).toHaveCount(0);
    await expect(page.locator('[data-id="pr-main-thread-chatter"]')).toHaveCount(0);

    await page.locator('#view-issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('[data-id="own-pr"]')).toHaveCount(0);
    await expect(page.locator('[data-id="others-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="pr-main-thread-chatter"]')).toBeVisible();
  });

  test('empty Replies state is shown when the open filter excludes replies', async ({ page }) => {
    const replyTabs = page.locator(
      '.subfilter-tabs[data-for-view="pr-notifications"][data-subfilter-group="state"]'
    );

    await replyTabs.locator('[data-subfilter="closed"]').click();

    await expect(page.locator('.notification-item')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
  });

  test('uses icon-only bottom actions on mobile Replies', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const reply = page.locator('[data-id="mentioned-pr"]');
    await expect(reply).toBeVisible();

    const bottomActions = reply.locator('.notification-actions-bottom');
    await expect(bottomActions).toBeVisible();
    await expect(bottomActions.getByRole('button', { name: 'Open notification in new tab' })).toBeVisible();
    await expect(bottomActions.getByRole('button', { name: 'Unsubscribe from notification' })).toBeVisible();
    await expect(bottomActions.getByRole('button', { name: 'Remove me as reviewer' })).toBeVisible();

    await expect(bottomActions.getByText('Open in new tab')).toBeHidden();
    await expect(bottomActions.getByText('Unsubscribe')).toBeHidden();
    await expect(bottomActions.getByText('Remove me')).toBeHidden();

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  });
});
