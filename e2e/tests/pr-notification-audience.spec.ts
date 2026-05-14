import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

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
  },
};

test.describe('Replies queue classification @classification', () => {
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
    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    await page.locator('#view-pr-notifications').click();
  });

  test('shows directed PR mentions and thread replies in Replies', async ({ page }) => {
    await expect(page.locator('#view-issues .count')).toHaveText('2');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('2');
    await expect(page.locator('#view-others-prs .count')).toHaveText('0');
    await expect(page.locator('.notification-item')).toHaveCount(2);

    await expect(page.locator('[data-id="own-pr"]')).not.toBeAttached();
    await expect(page.locator('[data-id="mentioned-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="reply-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="others-pr"]')).toHaveCount(0);

    await page.locator('#view-issues').click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('[data-id="own-pr"]')).toBeVisible();
    await expect(page.locator('[data-id="others-pr"]')).toBeVisible();
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
