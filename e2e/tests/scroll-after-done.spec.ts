import { test, expect } from '@playwright/test';

// Fixture with a first notification that has many comments to make it tall
const fixtureWithManyComments = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2024-12-27T12:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'notif-1',
      unread: true,
      reason: 'author',
      updated_at: '2024-12-27T11:30:00Z',
      // No last_read_at to force fetching all comments
      subject: {
        title: 'First notification with many comments',
        url: 'https://github.com/test/repo/issues/42',
        type: 'Issue',
        number: 42,
        state: 'open',
        state_reason: null,
      },
      actors: [
        {
          login: 'alice',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
      ],
      ui: { saved: false, done: false },
    },
    {
      id: 'notif-2',
      unread: false,
      reason: 'review_requested',
      updated_at: '2024-12-27T10:00:00Z',
      subject: {
        title: 'Second notification',
        url: 'https://github.com/test/repo/pull/43',
        type: 'PullRequest',
        number: 43,
        state: 'open',
        state_reason: null,
      },
      actors: [
        {
          login: 'bob',
          avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
        },
      ],
      ui: { saved: true, done: false },
    },
    {
      id: 'notif-3',
      unread: false,
      reason: 'mention',
      updated_at: '2024-12-26T15:00:00Z',
      subject: {
        title: 'Third notification',
        url: 'https://github.com/test/repo/issues/41',
        type: 'Issue',
        number: 41,
        state: 'closed',
        state_reason: 'completed',
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

// Many comments to make the first notification tall
const manyComments = Array.from({ length: 15 }, (_, i) => ({
  id: i + 1,
  user: { login: `user${i}` },
  body: `This is comment ${i + 1} with some text that makes it reasonably long. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  created_at: `2024-12-27T${String(10 + i).padStart(2, '0')}:00:00Z`,
  updated_at: `2024-12-27T${String(10 + i).padStart(2, '0')}:00:00Z`,
}));

/**
 * Tests for scroll behavior after marking a long notification as done.
 */
test.describe('Scroll After Done', () => {
  test.beforeEach(async ({ page }) => {
    // Mock auth endpoint
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Mock notifications endpoint
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixtureWithManyComments),
      });
    });

    // Mock comments endpoint for the first notification with many comments
    // (must be registered before the issue endpoint due to route matching order)
    await page.route('**/github/rest/repos/test/repo/issues/42/comments*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(manyComments),
      });
    });

    // Mock issue endpoint for fetchAllIssueComments
    await page.route('**/github/rest/repos/test/repo/issues/42', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 42,
          number: 42,
          user: { login: 'alice' },
          body: 'Initial issue body',
          created_at: '2024-12-27T09:00:00Z',
          updated_at: '2024-12-27T09:00:00Z',
        }),
      });
    });

    // Mock comments endpoint for other notifications (empty)
    await page.route('**/github/rest/repos/test/repo/issues/43/comments*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/41/comments*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock PR reviews endpoint
    await page.route('**/github/rest/repos/test/repo/pulls/*/reviews', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock rate limit
    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: { core: { limit: 5000, remaining: 4999, reset: 1735300000 } },
        }),
      });
    });
  });

  test('next notification is positioned at top of viewport after marking scrolled notification as done', async ({
    page,
  }) => {
    // Set a small viewport to ensure scrolling is needed
    await page.setViewportSize({ width: 1200, height: 400 });

    await page.goto('notifications.html');
    await page.evaluate(() => localStorage.clear());

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');

    // Enable comment expansion to make the first notification tall
    await page.locator('#comment-prefetch-toggle').check();
    await page.locator('#comment-expand-toggle').check();

    // Wait for comments to load and expand
    await expect
      .poll(
        async () =>
          page.locator('[data-id="notif-1"] .comment-list .comment-item').count(),
        { timeout: 10000 },
      )
      .toBeGreaterThan(5);

    // Scroll down so we're in the middle of the first notification
    // The header of the first notification should be out of view
    await page.evaluate(() => {
      const firstNotification = document.querySelector('[data-id="notif-1"]');
      if (firstNotification) {
        // Scroll so the top of the first notification is well above the viewport
        const rect = firstNotification.getBoundingClientRect();
        window.scrollBy(0, rect.top + 300);
      }
    });

    // Verify we've scrolled: the header should be out of view
    const headerVisible = await page.evaluate(() => {
      const header = document.querySelector('.app-header');
      if (!header) return true;
      const rect = header.getBoundingClientRect();
      return rect.bottom > 0;
    });
    expect(headerVisible).toBe(false);

    // Get the second notification element before marking done
    const secondNotification = page.locator('[data-id="notif-2"]');
    await expect(secondNotification).toBeVisible();

    // Mock the mark done API
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204 });
    });

    // Mark the first notification as done using the Done button
    await page.locator('[data-id="notif-1"] .notification-done-btn').first().click();

    // Wait for the notification to be removed
    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
    await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);

    // Allow scroll adjustment to complete
    await page.evaluate(() => new Promise(requestAnimationFrame));

    // The second notification should now be at the TOP of the viewport
    // (not way down with the banner taking up space at the top)
    const secondNotificationTop = await secondNotification.evaluate((el) => el.getBoundingClientRect().top);

    // The header height is around 60px, so the notification should be near the top
    // It should be within 100px of the top of the viewport (accounting for header + some margin)
    // The key assertion is that we're NOT showing the banner with lots of empty space above
    expect(secondNotificationTop).toBeLessThan(150);
    expect(secondNotificationTop).toBeGreaterThanOrEqual(0);
  });
});
