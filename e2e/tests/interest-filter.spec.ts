import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-02T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    // Issue with interesting comments
    {
      id: 'thread-interesting',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with interesting comments',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with only bot comments
    {
      id: 'thread-bot-only',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with bot comments only',
        url: 'https://github.com/test/repo/issues/2',
        type: 'Issue',
        number: 2,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with only bot commands
    {
      id: 'thread-bot-commands',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with bot commands only',
        url: 'https://github.com/test/repo/issues/3',
        type: 'Issue',
        number: 3,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    // Issue with no comments
    {
      id: 'thread-no-comments',
      unread: true,
      reason: 'subscribed',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Issue with no comments',
        url: 'https://github.com/test/repo/issues/4',
        type: 'Issue',
        number: 4,
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
    'thread-interesting': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 101,
          user: { login: 'human' },
          body: 'This is an interesting comment from a human.',
          created_at: '2025-01-01T02:00:00Z',
          updated_at: '2025-01-01T02:00:00Z',
        },
      ],
    },
    'thread-bot-only': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 201,
          user: { login: 'dependabot[bot]' },
          body: 'Bumps deps from 1.0 to 2.0',
          created_at: '2025-01-01T01:00:00Z',
          updated_at: '2025-01-01T01:00:00Z',
        },
        {
          id: 202,
          user: { login: 'github-actions[bot]' },
          body: 'CI passed',
          created_at: '2025-01-01T01:30:00Z',
          updated_at: '2025-01-01T01:30:00Z',
        },
      ],
    },
    'thread-bot-commands': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [
        {
          id: 301,
          user: { login: 'human' },
          body: '@pytorchbot label feature',
          created_at: '2025-01-01T01:00:00Z',
          updated_at: '2025-01-01T01:00:00Z',
        },
        {
          id: 302,
          user: { login: 'human2' },
          body: '/merge',
          created_at: '2025-01-01T01:30:00Z',
          updated_at: '2025-01-01T01:30:00Z',
        },
      ],
    },
    'thread-no-comments': {
      notificationUpdatedAt: '2025-01-02T00:00:00Z',
      lastReadAt: '2025-01-01T00:00:00Z',
      unread: true,
      allComments: false,
      fetchedAt: new Date().toISOString(),
      comments: [],
    },
  },
};

test.describe('Interest Filter', () => {
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

  test('displays interest filter tabs for Issues view', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );
    await expect(interestFilters).toBeVisible();
    await expect(interestFilters.locator('[data-subfilter="has-new"]')).toBeVisible();
    await expect(interestFilters.locator('[data-subfilter="no-new"]')).toBeVisible();
  });

  test('shows correct interest filter counts', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    // 1 interesting, 3 no-new (bot-only, bot-commands, no-comments)
    await expect(interestFilters.locator('[data-subfilter="has-new"] .count')).toHaveText('1');
    await expect(interestFilters.locator('[data-subfilter="no-new"] .count')).toHaveText('3');
  });

  test('clicking Has new filter shows only interesting notifications', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(interestFilters.locator('[data-subfilter="has-new"]')).toHaveClass(/active/);

    const items = page.locator('.notification-item');
    await expect(items).toHaveCount(1);
    await expect(page.locator('[data-id="thread-interesting"]')).toBeVisible();
  });

  test('clicking No new filter shows only uninteresting notifications', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="no-new"]').click();
    await expect(interestFilters.locator('[data-subfilter="no-new"]')).toHaveClass(/active/);

    const items = page.locator('.notification-item');
    await expect(items).toHaveCount(3);
    await expect(page.locator('[data-id="thread-bot-only"]')).toBeVisible();
    await expect(page.locator('[data-id="thread-bot-commands"]')).toBeVisible();
    await expect(page.locator('[data-id="thread-no-comments"]')).toBeVisible();
  });

  test('shows reason labels for uninteresting notifications', async ({ page }) => {
    // Check that the status badges show the correct reason
    const botOnlyStatus = page.locator('[data-id="thread-bot-only"] .comment-tag');
    const botCommandsStatus = page.locator('[data-id="thread-bot-commands"] .comment-tag');
    const noCommentsStatus = page.locator('[data-id="thread-no-comments"] .comment-tag');
    const interestingStatus = page.locator('[data-id="thread-interesting"] .comment-tag');

    await expect(botOnlyStatus).toContainText('Bot comments only');
    await expect(botCommandsStatus).toContainText('Bot commands only');
    await expect(noCommentsStatus).toContainText('No new comments');
    await expect(interestingStatus).toContainText('Interesting');
  });

  test('clicking active interest filter clears the filter', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    // First click to activate
    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    // Second click to deactivate
    await interestFilters.locator('[data-subfilter="has-new"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(4);
    await expect(interestFilters.locator('.subfilter-tab.active')).toHaveCount(0);
  });

  test('interest filter persists in localStorage', async ({ page }) => {
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );

    await interestFilters.locator('[data-subfilter="no-new"]').click();

    const savedViewFilters = await page.evaluate(() =>
      localStorage.getItem('ghnotif_view_filters')
    );
    const parsed = JSON.parse(savedViewFilters!);
    expect(parsed).toHaveProperty('issues');
    expect(parsed.issues).toHaveProperty('interest', 'no-new');
  });

  test('interest filter works with state filter combined', async ({ page }) => {
    // Create a fixture with mixed states
    const mixedStateFixture = {
      ...notificationsResponse,
      notifications: [
        ...notificationsResponse.notifications,
        // Add a closed issue with interesting comments
        {
          id: 'thread-closed-interesting',
          unread: true,
          reason: 'subscribed',
          updated_at: '2025-01-02T00:00:00Z',
          last_read_at: '2025-01-01T00:00:00Z',
          subject: {
            title: 'Closed issue with interesting comments',
            url: 'https://github.com/test/repo/issues/5',
            type: 'Issue',
            number: 5,
            state: 'closed',
            state_reason: 'completed',
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
    };

    const extendedCommentCache = {
      ...commentCache,
      threads: {
        ...commentCache.threads,
        'thread-closed-interesting': {
          notificationUpdatedAt: '2025-01-02T00:00:00Z',
          lastReadAt: '2025-01-01T00:00:00Z',
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [
            {
              id: 501,
              user: { login: 'human' },
              body: 'This is resolved now.',
              created_at: '2025-01-01T02:00:00Z',
              updated_at: '2025-01-01T02:00:00Z',
            },
          ],
        },
      },
    };

    // Re-route with new fixture
    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedStateFixture),
      });
    });

    await seedCommentCache(page, extendedCommentCache);
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');

    // Apply state filter first
    const stateFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]'
    );
    await stateFilters.locator('[data-subfilter="open"]').click();

    // Now apply interest filter
    const interestFilters = page.locator(
      '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="interest"]'
    );
    await interestFilters.locator('[data-subfilter="has-new"]').click();

    // Should show only open + interesting = 1 item
    const items = page.locator('.notification-item');
    await expect(items).toHaveCount(1);
    await expect(page.locator('[data-id="thread-interesting"]')).toBeVisible();
  });
});
