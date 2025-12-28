import { test, expect } from '@playwright/test';

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
        title: 'Comment visibility check',
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

test.describe('Comment visibility', () => {
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
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [
            {
              id: 201,
              user: { login: 'dependabot[bot]' },
              body: 'Bumps deps',
              created_at: '2025-01-01T01:00:00Z',
              updated_at: '2025-01-01T01:00:00Z',
            },
            {
              id: 202,
              user: { login: 'human' },
              body: '@pytorchbot label feature',
              created_at: '2025-01-01T01:30:00Z',
              updated_at: '2025-01-01T01:30:00Z',
            },
            {
              id: 203,
              user: { login: 'human' },
              body: 'Please take a look at this.',
              created_at: '2025-01-01T02:00:00Z',
              updated_at: '2025-01-01T02:00:00Z',
            },
          ],
        },
      },
    };

    await page.addInitScript((cache) => {
      localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      localStorage.setItem('ghnotif_comment_expand_enabled', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
      localStorage.setItem('ghnotif_bulk_comment_cache_v1', JSON.stringify(cache));
    }, commentCache);

    await page.goto('notifications.html');

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('hides uninteresting comments when enabled', async ({ page }) => {
    await expect(page.locator('.comment-item')).toHaveCount(3);
    await expect(page.locator('.comment-item').nth(0)).toContainText(
      'Bumps deps'
    );
    await expect(page.locator('.comment-item').nth(1)).toContainText(
      '@pytorchbot label feature'
    );
    await expect(page.locator('.comment-item').nth(2)).toContainText(
      'Please take a look at this.'
    );

    await page.locator('#comment-hide-uninteresting-toggle').check();

    await expect(page.locator('.comment-item')).toHaveCount(1);
    await expect(page.locator('.comment-item').first()).toContainText(
      'Please take a look at this.'
    );
  });

  test('shows bottom mark done button when comments are expanded', async ({
    page,
  }) => {
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204, body: '' });
    });

    const bottomDoneButton = page.locator('.notification-done-btn-bottom');
    await expect(bottomDoneButton).toBeVisible();

    await bottomDoneButton.click();

    await expect(page.locator('#status-bar')).toContainText(
      'Marked 1 notification as done'
    );
    await expect(page.locator('.notification-item')).toHaveCount(0);
  });

  test('shows open in new tab button when comments are expanded', async ({
    page,
  }) => {
    const openButton = page.locator('.notification-open-btn-bottom');
    await expect(openButton).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      openButton.click(),
    ]);

    await expect(popup).toHaveURL('https://github.com/test/repo/issues/1');
    await popup.close();
  });

  test('uses GitHub-sized comment typography with a wider layout', async ({
    page,
  }) => {
    const commentBody = page.locator('.comment-body').first();
    await expect(commentBody).toBeVisible();

    const fontSize = await commentBody.evaluate((element) => {
      return window.getComputedStyle(element).fontSize;
    });
    expect(fontSize).toBe('14px');

    const container = page.locator('.container');
    const maxWidth = await container.evaluate((element) => {
      return window.getComputedStyle(element).maxWidth;
    });
    expect(maxWidth).toBe('1200px');
  });

  test('notification header has sticky positioning when comments are expanded', async ({
    page,
  }) => {
    const notificationHeader = page.locator('.notification-header').first();
    await expect(notificationHeader).toBeVisible();

    const position = await notificationHeader.evaluate((element) => {
      return window.getComputedStyle(element).position;
    });
    expect(position).toBe('sticky');

    const top = await notificationHeader.evaluate((element) => {
      return window.getComputedStyle(element).top;
    });
    expect(top).toBe('0px');
  });
});

test.describe('Own comment filtering', () => {
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
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [
            {
              id: 301,
              user: { login: 'reviewer' },
              body: 'Please review.',
              created_at: '2025-01-01T01:00:00Z',
              updated_at: '2025-01-01T01:00:00Z',
            },
            {
              id: 302,
              user: { login: 'testuser' },
              body: 'Looking now.',
              created_at: '2025-01-01T02:00:00Z',
              updated_at: '2025-01-01T02:00:00Z',
            },
            {
              id: 303,
              user: { login: 'reviewer' },
              body: 'Thanks for checking in.',
              created_at: '2025-01-01T03:00:00Z',
              updated_at: '2025-01-01T03:00:00Z',
            },
          ],
        },
      },
    };

    await page.addInitScript((cache) => {
      localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      localStorage.setItem('ghnotif_comment_expand_enabled', 'true');
      localStorage.setItem('ghnotif_comment_hide_uninteresting', 'false');
      localStorage.setItem('ghnotif_bulk_comment_cache_v1', JSON.stringify(cache));
    }, commentCache);

    await page.goto('notifications.html');

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test('hides own comments and earlier items in expanded view', async ({
    page,
  }) => {
    await expect(page.locator('.comment-item')).toHaveCount(1);
    await expect(page.locator('.comment-item').first()).toContainText(
      'Thanks for checking in.'
    );
  });
});
