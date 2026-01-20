import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

// Create comments with different ages
const now = new Date();
const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: now.toISOString(),
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
      updated_at: now.toISOString(),
      last_read_at: twoMonthsAgo.toISOString(),
      subject: {
        title: 'Issue with comments of various ages',
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

const commentCache = {
  version: 1,
  threads: {
    'thread-1': {
      notificationUpdatedAt: now.toISOString(),
      lastReadAt: twoMonthsAgo.toISOString(),
      unread: true,
      allComments: false,
      fetchedAt: now.toISOString(),
      comments: [
        {
          id: 1,
          user: { login: 'user1' },
          body: 'Comment from 1 hour ago',
          created_at: oneHourAgo.toISOString(),
          updated_at: oneHourAgo.toISOString(),
        },
        {
          id: 2,
          user: { login: 'user2' },
          body: 'Comment from 2 days ago',
          created_at: twoDaysAgo.toISOString(),
          updated_at: twoDaysAgo.toISOString(),
        },
        {
          id: 3,
          user: { login: 'user3' },
          body: 'Comment from 5 days ago',
          created_at: fiveDaysAgo.toISOString(),
          updated_at: fiveDaysAgo.toISOString(),
        },
        {
          id: 4,
          user: { login: 'user4' },
          body: 'Comment from 2 weeks ago',
          created_at: twoWeeksAgo.toISOString(),
          updated_at: twoWeeksAgo.toISOString(),
        },
        {
          id: 5,
          user: { login: 'user5' },
          body: 'Comment from 2 months ago',
          created_at: twoMonthsAgo.toISOString(),
          updated_at: twoMonthsAgo.toISOString(),
        },
      ],
    },
  },
};

test.describe('Comment Age Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
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

    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
      localStorage.setItem('ghnotif_comment_expand_issues', 'true');
    });
    await seedCommentCache(page, commentCache);
    await page.reload();
    await page.evaluate(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('age filter dropdown is visible', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await expect(ageFilter).toBeVisible();
  });

  test('age filter defaults to All time', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await expect(ageFilter).toHaveValue('all');
  });

  test('shows all comments when set to All time', async ({ page }) => {
    const comments = page.locator('.comment-item');
    await expect(comments).toHaveCount(5);
  });

  test('selecting Last 1 day hides older comments', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await ageFilter.selectOption('1day');

    // Only the 1 hour ago comment should be visible
    const comments = page.locator('.comment-item');
    await expect(comments).toHaveCount(1);
    await expect(comments.first()).toContainText('Comment from 1 hour ago');
  });

  test('selecting Last 3 days shows comments from last 3 days', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await ageFilter.selectOption('3days');

    // 1 hour ago and 2 days ago should be visible
    const comments = page.locator('.comment-item');
    await expect(comments).toHaveCount(2);
    await expect(comments.nth(0)).toContainText('Comment from 1 hour ago');
    await expect(comments.nth(1)).toContainText('Comment from 2 days ago');
  });

  test('selecting Last 1 week shows comments from last week', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await ageFilter.selectOption('1week');

    // 1 hour ago, 2 days ago, and 5 days ago should be visible
    const comments = page.locator('.comment-item');
    await expect(comments).toHaveCount(3);
  });

  test('selecting Last 1 month shows comments from last month', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await ageFilter.selectOption('1month');

    // 1 hour ago, 2 days ago, 5 days ago, and 2 weeks ago should be visible
    const comments = page.locator('.comment-item');
    await expect(comments).toHaveCount(4);
  });

  test('age filter persists in localStorage', async ({ page }) => {
    const ageFilter = page.locator('#comment-age-filter-select');
    await ageFilter.selectOption('1week');

    const savedFilter = await page.evaluate(() =>
      localStorage.getItem('ghnotif_comment_age_filter')
    );
    expect(savedFilter).toBe('1week');
  });

  test('age filter is restored from localStorage on reload', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_comment_age_filter', '3days');
    });
    await seedCommentCache(page, commentCache);
    await page.reload();

    const ageFilter = page.locator('#comment-age-filter-select');
    await expect(ageFilter).toHaveValue('3days');
  });
});
