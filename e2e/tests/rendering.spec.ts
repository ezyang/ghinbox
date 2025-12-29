import { test, expect } from '@playwright/test';
import { clearAppStorage } from './storage-utils';

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
      reason: 'subscribed',
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
      reason: 'subscribed',
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
    await clearAppStorage(page);

    // Trigger sync
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);
  });

  test.describe('Notification Structure', () => {
    test('renders core structure and attributes', async ({ page }) => {
      const firstItem = page.locator('.notification-item').first();

      await expect(firstItem.locator('.notification-icon svg')).toBeAttached();
      await expect(firstItem.locator('.notification-title')).toHaveAttribute(
        'href',
        /github\.com/
      );
      await expect(firstItem.locator('.notification-time')).toBeVisible();

      const dataId = await firstItem.getAttribute('data-id');
      expect(dataId).toBeTruthy();
      await expect(firstItem).toHaveAttribute('data-type', 'Issue');
      await expect(firstItem).toHaveAttribute('data-state', 'open');
    });
  });

  test.describe('PR diffstat badge', () => {
    test('shows additions/deletions for pull requests', async ({ page }) => {
      await page.route('**/github/rest/repos/test/repo/issues/*', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 123,
            number: 10,
            user: { login: 'charlie' },
            body: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
      });

      await page.route('**/github/rest/repos/test/repo/issues/*/comments*', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      });

      await page.route('**/github/graphql', async (route) => {
        const payload = route.request().postDataJSON();
        if (payload?.query?.includes('repository')) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                rateLimit: {
                  limit: 5000,
                  remaining: 4999,
                  resetAt: '2025-01-02T00:00:00Z',
                },
                repository: {
                  pr10: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 120,
                    deletions: 45,
                    changedFiles: 6,
                  },
                  pr11: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 4,
                    deletions: 2,
                    changedFiles: 1,
                  },
                },
              },
            }),
          });
          return;
        }
        route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
      });

      await page.evaluate(() => {
        localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      });
      await page.reload();
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();

      await page.locator('#view-others-prs').click();
      await expect(page.locator('[data-id="pr-open"]')).toBeVisible();
      const diffstat = page.locator('[data-id="pr-open"] .diffstat-tag');
      await expect(diffstat).toHaveText('+120/-45');
      await expect(diffstat).toHaveAttribute('title', /Changes: 165/);
    });
  });

  test.describe('Ordering by PR size', () => {
    test('sorts PRs smallest to largest and scales diffstat color', async ({ page }) => {
      await page.route('**/github/rest/repos/test/repo/issues/*', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 123,
            number: 10,
            user: { login: 'charlie' },
            body: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
      });

      await page.route('**/github/rest/repos/test/repo/issues/*/comments*', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      });

      await page.route('**/github/graphql', async (route) => {
        const payload = route.request().postDataJSON();
        if (payload?.query?.includes('repository')) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                rateLimit: {
                  limit: 5000,
                  remaining: 4999,
                  resetAt: '2025-01-02T00:00:00Z',
                },
                repository: {
                  pr10: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 8,
                    deletions: 2,
                    changedFiles: 1,
                  },
                  pr11: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 15,
                    deletions: 5,
                    changedFiles: 2,
                  },
                  pr12: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 3,
                    deletions: 2,
                    changedFiles: 1,
                  },
                  pr13: {
                    reviewDecision: null,
                    authorAssociation: null,
                    additions: 30,
                    deletions: 20,
                    changedFiles: 6,
                  },
                },
              },
            }),
          });
          return;
        }
        route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
      });

      await page.evaluate(() => {
        localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      });
      await page.reload();
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();

      await page.locator('#view-others-prs').click();
      await expect(page.locator('[data-id="pr-closed"] .diffstat-tag')).toHaveText('+3/-2');
      await page.locator('#order-select').selectOption('size');

      const ids = await page.locator('.notification-item').evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-id'))
      );
      expect(ids[0]).toBe('pr-closed');
      expect(ids[ids.length - 1]).toBe('pr-draft');

      const smallStyle = await page
        .locator('[data-id="pr-closed"] .diffstat-tag')
        .getAttribute('style');
      const largeStyle = await page
        .locator('[data-id="pr-draft"] .diffstat-tag')
        .getAttribute('style');
      expect(smallStyle).toContain('--diffstat-hue: 120');
      expect(largeStyle).toContain('--diffstat-hue: 0');
    });
  });

  test.describe('Icons and Badges', () => {
    test('renders issue/pr icons and state badges', async ({ page }) => {
      const issueIcon = page.locator('[data-id="issue-open"] .notification-icon');
      await expect(issueIcon).toHaveClass(/open/);
      await expect(issueIcon).toHaveAttribute('data-type', 'Issue');

      const issueBadge = page.locator('[data-id="issue-closed"] .state-badge');
      await expect(issueBadge).toContainText('Closed');
      await expect(issueBadge).toHaveClass(/completed/);

      await page.locator('#view-others-prs').click();
      const prIcon = page.locator('[data-id="pr-merged"] .notification-icon');
      await expect(prIcon).toHaveClass(/merged/);
      await expect(prIcon).toHaveAttribute('data-type', 'PullRequest');

      const prBadge = page.locator('[data-id="pr-merged"] .state-badge');
      await expect(prBadge).toContainText('Merged');
    });
  });

  test.describe('Reason Labels', () => {
    test('renders author and review requested reasons', async ({ page }) => {
      const authorReason = page.locator('[data-id="issue-open"] .notification-reason');
      await expect(authorReason).toContainText('Author');

      await page.locator('#view-others-prs').click();
      const reviewReason = page.locator('[data-id="pr-open"] .notification-reason');
      await expect(reviewReason).toContainText('Review requested');
    });
  });

  test.describe('Timestamps', () => {
    test('timestamp exposes datetime and title', async ({ page }) => {
      const time = page.locator('[data-id="issue-open"] .notification-time');
      await expect(time).toContainText(/ago|now/);
      const datetime = await time.getAttribute('datetime');
      const title = await time.getAttribute('title');
      expect(datetime).toBeTruthy();
      expect(new Date(datetime!).getTime()).not.toBeNaN();
      expect(title).toBeTruthy();
    });
  });

  test.describe('Actor Avatars', () => {
    test('shows avatars when present and hides actors when absent', async ({ page }) => {
      const avatar = page.locator('[data-id="issue-open"] .actor-avatar').first();
      await expect(avatar).toBeVisible();
      await expect(avatar).toHaveAttribute('alt', 'alice');
      await expect(avatar).toHaveAttribute('title', 'alice');

      const noActors = page.locator('[data-id="issue-not-planned"] .notification-actors');
      await expect(noActors).not.toBeAttached();
    });
  });

  test.describe('Unread Indicator', () => {
    test('unread vs read styles are applied', async ({ page }) => {
      await expect(page.locator('[data-id="issue-open"]')).toHaveClass(/unread/);
      await expect(page.locator('[data-id="issue-closed"]')).not.toHaveClass(/unread/);
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
    await clearAppStorage(page);
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
