import { test, expect } from '@playwright/test';
import { clearAppStorage } from './storage-utils';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-08T12:00:00Z',
  repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
  authenticity_token: 'token',
  notifications: [
    {
      id: 'bookmark-1',
      unread: true,
      reason: 'mention',
      updated_at: '2025-01-08T12:00:00Z',
      last_read_at: '2025-01-08T11:00:00Z',
      subject: {
        title: 'Bookmark me',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false, bookmarked: false, action_tokens: { archive: 'token' } },
    },
    {
      id: 'bookmark-2',
      unread: false,
      reason: 'subscribed',
      updated_at: '2025-01-08T11:00:00Z',
      last_read_at: '2025-01-08T10:00:00Z',
      subject: {
        title: 'Stay new',
        url: 'https://github.com/test/repo/issues/2',
        type: 'Issue',
        number: 2,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false, bookmarked: false, action_tokens: { archive: 'token' } },
    },
  ],
};

test.describe('Bookmark', () => {
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
        body: JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } }),
      });
    });
    await page.route('**/github/graphql', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    });
    await page.route('**/github/rest/repos/**/issues/*/comments**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });
    await page.route('**/api/snapshots/test/repo', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshot: null }) });
    });
  });

  test('moves a feed notification between New and Bookmarked without marking done', async ({ page }) => {
    const bookmarkBodies: unknown[] = [];
    let actionCalled = false;

    await page.route('**/notifications/html/repo/test/repo/bookmarks/**', async (route) => {
      bookmarkBodies.push(await route.request().postDataJSON());
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          repo: 'test/repo',
          notification_id: 'bookmark-1',
          bookmarked: bookmarkBodies.length === 1,
        }),
      });
    });
    await page.route('**/notifications/html/action', (route) => {
      actionCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
    });
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      if (route.request().url().includes('/bookmarks/')) {
        return route.fallback();
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('[data-subfilter-group="bookmark"] [data-subfilter="new"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await page
      .locator('[data-id="bookmark-1"] .notification-actions-inline .notification-bookmark-btn')
      .click();

    await expect.poll(() => bookmarkBodies.length).toBe(1);
    expect(bookmarkBodies[0]).toEqual({ bookmarked: true });
    expect(actionCalled).toBe(false);
    await expect(page.locator('[data-id="bookmark-1"]')).toBeHidden();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    await page.locator('[data-subfilter-group="bookmark"] [data-subfilter="bookmarked"]').click();
    await expect(page.locator('[data-id="bookmark-1"]')).toBeVisible();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    await page
      .locator('[data-id="bookmark-1"] .notification-actions-inline .notification-bookmark-btn')
      .click();
    await expect.poll(() => bookmarkBodies.length).toBe(2);
    expect(bookmarkBodies[1]).toEqual({ bookmarked: false });
    await expect(page.locator('[data-id="bookmark-1"]')).toBeHidden();

    await page.locator('[data-subfilter-group="bookmark"] [data-subfilter="new"]').click();
    await expect(page.locator('[data-id="bookmark-1"]')).toBeVisible();
    await expect(page.locator('[data-id="bookmark-2"]')).toBeVisible();
  });
});
