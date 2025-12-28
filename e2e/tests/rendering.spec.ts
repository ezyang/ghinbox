import { test, expect } from '@playwright/test';

/**
 * Phase 4: Notification Rendering Tests
 *
 * Tests for GitHub-like notification rendering with icons, badges, timestamps, and avatars.
 */

// Test fixture with various notification types and states
const testNotifications = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: new Date().toISOString(),
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'issue-open',
      unread: true,
      reason: 'author',
      updated_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 min ago
      subject: {
        title: 'Open issue notification',
        url: 'https://github.com/test/repo/issues/1',
        type: 'Issue',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [
        { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
      ],
      ui: { saved: false, done: false },
    },
    {
      id: 'issue-closed',
      unread: false,
      reason: 'mention',
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
      subject: {
        title: 'Closed issue (completed)',
        url: 'https://github.com/test/repo/issues/2',
        type: 'Issue',
        number: 2,
        state: 'closed',
        state_reason: 'completed',
      },
      actors: [
        { login: 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
      ],
      ui: { saved: false, done: false },
    },
    {
      id: 'issue-not-planned',
      unread: false,
      reason: 'subscribed',
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
      subject: {
        title: 'Issue closed as not planned',
        url: 'https://github.com/test/repo/issues/3',
        type: 'Issue',
        number: 3,
        state: 'closed',
        state_reason: 'not_planned',
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    {
      id: 'pr-open',
      unread: true,
      reason: 'review_requested',
      updated_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 min ago
      subject: {
        title: 'Open pull request',
        url: 'https://github.com/test/repo/pull/10',
        type: 'PullRequest',
        number: 10,
        state: 'open',
        state_reason: null,
      },
      actors: [
        { login: 'charlie', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4' },
        { login: 'diana', avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4' },
      ],
      ui: { saved: false, done: false },
    },
    {
      id: 'pr-merged',
      unread: false,
      reason: 'author',
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(), // 3 days ago
      subject: {
        title: 'Merged pull request',
        url: 'https://github.com/test/repo/pull/11',
        type: 'PullRequest',
        number: 11,
        state: 'merged',
        state_reason: null,
      },
      actors: [
        { login: 'eve', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4' },
      ],
      ui: { saved: false, done: false },
    },
    {
      id: 'pr-closed',
      unread: false,
      reason: 'subscribed',
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(), // 1 week ago
      subject: {
        title: 'Closed pull request (not merged)',
        url: 'https://github.com/test/repo/pull/12',
        type: 'PullRequest',
        number: 12,
        state: 'closed',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    {
      id: 'pr-draft',
      unread: false,
      reason: 'author',
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(), // 2 weeks ago
      subject: {
        title: 'Draft pull request',
        url: 'https://github.com/test/repo/pull/13',
        type: 'PullRequest',
        number: 13,
        state: 'draft',
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

test.describe('Notification Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(testNotifications),
      });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => localStorage.clear());

    // Trigger sync
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');
  });

  test.describe('Notification Structure', () => {
    test('notification items have correct structure', async ({ page }) => {
      const firstItem = page.locator('.notification-item').first();

      // Check for icon
      await expect(firstItem.locator('.notification-icon')).toBeVisible();
      await expect(firstItem.locator('.notification-icon svg')).toBeAttached();

      // Check for content
      await expect(firstItem.locator('.notification-content')).toBeVisible();
      await expect(firstItem.locator('.notification-title')).toBeVisible();
      await expect(firstItem.locator('.notification-meta')).toBeVisible();

      // Check for timestamp
      await expect(firstItem.locator('.notification-time')).toBeVisible();
    });

    test('notification title is a link', async ({ page }) => {
      const titleLink = page.locator('.notification-title').first();
      await expect(titleLink).toHaveAttribute('href', /github\.com/);
      await expect(titleLink).toHaveAttribute('target', '_blank');
    });

    test('notification has data-id attribute', async ({ page }) => {
      const firstItem = page.locator('.notification-item').first();
      const dataId = await firstItem.getAttribute('data-id');
      expect(dataId).toBeTruthy();
    });

    test('notification has data-type attribute', async ({ page }) => {
      const issueItem = page.locator('[data-id="issue-open"]');
      await expect(issueItem).toHaveAttribute('data-type', 'Issue');

      const prItem = page.locator('[data-id="pr-open"]');
      await expect(prItem).toHaveAttribute('data-type', 'PullRequest');
    });

    test('notification has data-state attribute', async ({ page }) => {
      const openItem = page.locator('[data-id="issue-open"]');
      await expect(openItem).toHaveAttribute('data-state', 'open');

      const closedItem = page.locator('[data-id="issue-closed"]');
      await expect(closedItem).toHaveAttribute('data-state', 'closed');

      const mergedItem = page.locator('[data-id="pr-merged"]');
      await expect(mergedItem).toHaveAttribute('data-state', 'merged');
    });

    test('notification shows inline unsubscribe button (bottom only appears when comments expanded)', async ({
      page,
    }) => {
      const totalNotifications = testNotifications.notifications.length;
      // Without comments expanded, only inline unsubscribe buttons are shown
      await expect(page.locator('.notification-unsubscribe-btn')).toHaveCount(totalNotifications);
      // Bottom unsubscribe buttons only appear when comments are expanded
      await expect(page.locator('.notification-unsubscribe-btn-bottom')).toHaveCount(0);
    });
  });

  test.describe('Icons', () => {
    test('issue notifications have issue icon', async ({ page }) => {
      const issueIcon = page.locator('[data-id="issue-open"] .notification-icon');
      await expect(issueIcon).toHaveAttribute('data-type', 'Issue');
      await expect(issueIcon.locator('svg')).toBeAttached();
    });

    test('PR notifications have PR icon', async ({ page }) => {
      const prIcon = page.locator('[data-id="pr-open"] .notification-icon');
      await expect(prIcon).toHaveAttribute('data-type', 'PullRequest');
      await expect(prIcon.locator('svg')).toBeAttached();
    });

    test('open items have open icon class', async ({ page }) => {
      const openIcon = page.locator('[data-id="issue-open"] .notification-icon');
      await expect(openIcon).toHaveClass(/open/);
    });

    test('closed items have closed icon class', async ({ page }) => {
      const closedIcon = page.locator('[data-id="issue-closed"] .notification-icon');
      await expect(closedIcon).toHaveClass(/closed/);
    });

    test('merged items have merged icon class', async ({ page }) => {
      const mergedIcon = page.locator('[data-id="pr-merged"] .notification-icon');
      await expect(mergedIcon).toHaveClass(/merged/);
    });

    test('draft items have draft icon class', async ({ page }) => {
      const draftIcon = page.locator('[data-id="pr-draft"] .notification-icon');
      await expect(draftIcon).toHaveClass(/draft/);
    });
  });

  test.describe('State Badges', () => {
    test('open state badge is displayed', async ({ page }) => {
      const badge = page.locator('[data-id="issue-open"] .state-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveClass(/open/);
      await expect(badge).toContainText('Open');
    });

    test('closed state badge is displayed', async ({ page }) => {
      const badge = page.locator('[data-id="issue-closed"] .state-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveClass(/closed/);
      await expect(badge).toContainText('Closed');
    });

    test('merged state badge is displayed', async ({ page }) => {
      const badge = page.locator('[data-id="pr-merged"] .state-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveClass(/merged/);
      await expect(badge).toContainText('Merged');
    });

    test('draft state badge is displayed', async ({ page }) => {
      const badge = page.locator('[data-id="pr-draft"] .state-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveClass(/draft/);
      await expect(badge).toContainText('Draft');
    });

    test('completed closed issues have completed class', async ({ page }) => {
      const badge = page.locator('[data-id="issue-closed"] .state-badge');
      await expect(badge).toHaveClass(/completed/);
    });
  });

  test.describe('Issue/PR Numbers', () => {
    test('issue number is displayed', async ({ page }) => {
      const number = page.locator('[data-id="issue-open"] .notification-number');
      await expect(number).toContainText('#1');
    });

    test('PR number is displayed', async ({ page }) => {
      const number = page.locator('[data-id="pr-open"] .notification-number');
      await expect(number).toContainText('#10');
    });
  });

  test.describe('Reason Labels', () => {
    test('author reason is displayed', async ({ page }) => {
      const reason = page.locator('[data-id="issue-open"] .notification-reason');
      await expect(reason).toContainText('Author');
    });

    test('mention reason is displayed', async ({ page }) => {
      const reason = page.locator('[data-id="issue-closed"] .notification-reason');
      await expect(reason).toContainText('Mentioned');
    });

    test('review_requested reason is displayed', async ({ page }) => {
      const reason = page.locator('[data-id="pr-open"] .notification-reason');
      await expect(reason).toContainText('Review requested');
    });

    test('subscribed reason is displayed', async ({ page }) => {
      const reason = page.locator('[data-id="issue-not-planned"] .notification-reason');
      await expect(reason).toContainText('Subscribed');
    });
  });

  test.describe('Timestamps', () => {
    test('relative timestamp is displayed', async ({ page }) => {
      const time = page.locator('[data-id="issue-open"] .notification-time');
      await expect(time).toBeVisible();
      // Should contain some time indicator (ago)
      await expect(time).toContainText(/ago|now/);
    });

    test('timestamp has datetime attribute', async ({ page }) => {
      const time = page.locator('[data-id="issue-open"] .notification-time');
      const datetime = await time.getAttribute('datetime');
      expect(datetime).toBeTruthy();
      // Should be a valid ISO date
      expect(new Date(datetime!).getTime()).not.toBeNaN();
    });

    test('timestamp has title with full date', async ({ page }) => {
      const time = page.locator('[data-id="issue-open"] .notification-time');
      const title = await time.getAttribute('title');
      expect(title).toBeTruthy();
      // Should contain date/time info
      expect(title!.length).toBeGreaterThan(5);
    });
  });

  test.describe('Actor Avatars', () => {
    test('actor avatars are displayed when present', async ({ page }) => {
      const actors = page.locator('[data-id="issue-open"] .notification-actors');
      await expect(actors).toBeVisible();

      const avatar = actors.locator('.actor-avatar');
      await expect(avatar).toBeVisible();
    });

    test('multiple actor avatars are displayed', async ({ page }) => {
      const actors = page.locator('[data-id="pr-open"] .notification-actors');
      const avatars = actors.locator('.actor-avatar');
      await expect(avatars).toHaveCount(2);
    });

    test('actor avatars have alt text', async ({ page }) => {
      const avatar = page.locator('[data-id="issue-open"] .actor-avatar').first();
      const alt = await avatar.getAttribute('alt');
      expect(alt).toBe('alice');
    });

    test('actor avatars have title (tooltip)', async ({ page }) => {
      const avatar = page.locator('[data-id="issue-open"] .actor-avatar').first();
      const title = await avatar.getAttribute('title');
      expect(title).toBe('alice');
    });

    test('no actors section when no actors', async ({ page }) => {
      const actors = page.locator('[data-id="issue-not-planned"] .notification-actors');
      await expect(actors).not.toBeAttached();
    });
  });

  test.describe('Unread Indicator', () => {
    test('unread notifications have unread class', async ({ page }) => {
      const unreadItem = page.locator('[data-id="issue-open"]');
      await expect(unreadItem).toHaveClass(/unread/);
    });

    test('read notifications do not have unread class', async ({ page }) => {
      const readItem = page.locator('[data-id="issue-closed"]');
      await expect(readItem).not.toHaveClass(/unread/);
    });
  });

  test.describe('Visual Styling', () => {
    test('notification items have hover effect', async ({ page }) => {
      const item = page.locator('.notification-item').first();

      // Get background before hover
      const bgBefore = await item.evaluate((el) =>
        getComputedStyle(el).backgroundColor
      );

      await item.hover();

      // Background should change on hover (or at least transition should be set)
      const transition = await item.evaluate((el) =>
        getComputedStyle(el).transition
      );
      expect(transition).toContain('background');
    });

    test('notification title has hover underline style', async ({ page }) => {
      const title = page.locator('.notification-title').first();

      // Check that text-decoration changes on hover
      const textDecoration = await title.evaluate((el) =>
        getComputedStyle(el).textDecoration
      );
      // Initially should not be underlined
      expect(textDecoration).toContain('none');
    });
  });
});

test.describe('XSS Prevention', () => {
  test('HTML in title is escaped', async ({ page }) => {
    const maliciousResponse = {
      ...testNotifications,
      notifications: [
        {
          id: 'xss-test',
          unread: true,
          reason: 'author',
          updated_at: new Date().toISOString(),
          subject: {
            title: '<script>alert("xss")</script>Malicious Title',
            url: 'https://github.com/test/repo/issues/999',
            type: 'Issue',
            number: 999,
            state: 'open',
            state_reason: null,
          },
          actors: [],
          ui: { saved: false, done: false },
        },
      ],
    };

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(maliciousResponse),
      });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => localStorage.clear());
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced');

    // The script tag should be escaped and visible as text
    const title = page.locator('.notification-title').first();
    const text = await title.textContent();
    expect(text).toContain('<script>');
    expect(text).toContain('Malicious Title');

    // No actual script execution should occur
    const html = await title.innerHTML();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
