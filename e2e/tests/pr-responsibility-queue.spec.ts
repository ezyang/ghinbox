import { test, expect } from '@playwright/test';
import { clearAppStorage } from './storage-utils';

const emptyNotifications = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-05T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

const reviewRequestSearch = {
  total_count: 3,
  incomplete_results: false,
  items: [
    {
      number: 10,
      title: 'Needs my review',
      html_url: 'https://github.com/test/repo/pull/10',
      state: 'open',
      draft: false,
      updated_at: '2025-01-05T12:00:00Z',
      created_at: '2025-01-05T10:00:00Z',
      user: { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
      pull_request: {},
    },
    {
      number: 11,
      title: 'Already approved',
      html_url: 'https://github.com/test/repo/pull/11',
      state: 'open',
      draft: false,
      updated_at: '2025-01-05T11:00:00Z',
      created_at: '2025-01-05T09:00:00Z',
      user: { login: 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
      pull_request: {},
    },
    {
      number: 12,
      title: 'Changes requested',
      html_url: 'https://github.com/test/repo/pull/12',
      state: 'open',
      draft: false,
      updated_at: '2025-01-05T10:00:00Z',
      created_at: '2025-01-05T08:00:00Z',
      user: { login: 'carol', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4' },
      pull_request: {},
    },
  ],
};

test.describe('PR responsibility queue', () => {
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
        body: JSON.stringify(emptyNotifications),
      });
    });

    await page.route(/\/github\/rest\/search\/issues.*/, (route) => {
      expect(decodeURIComponent(route.request().url())).toContain(
        'review-requested:testuser'
      );
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(reviewRequestSearch),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/*/comments*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/github/rest/repos/test/repo/collaborators/*/permission', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'read', role_name: 'read' }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      const payload = route.request().postDataJSON();
      if (payload?.query?.includes('pullRequest')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              rateLimit: {
                limit: 5000,
                remaining: 4999,
                resetAt: '2025-01-05T00:00:00Z',
              },
              repository: {
                pr10: {
                  reviewDecision: null,
                  authorAssociation: 'CONTRIBUTOR',
                  additions: 5,
                  deletions: 1,
                  changedFiles: 1,
                  author: { login: 'alice' },
                },
                pr11: {
                  reviewDecision: 'APPROVED',
                  authorAssociation: 'CONTRIBUTOR',
                  additions: 10,
                  deletions: 2,
                  changedFiles: 1,
                  author: { login: 'bob' },
                },
                pr12: {
                  reviewDecision: 'CHANGES_REQUESTED',
                  authorAssociation: 'CONTRIBUTOR',
                  additions: 15,
                  deletions: 3,
                  changedFiles: 2,
                  author: { login: 'carol' },
                },
              },
            },
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2025-01-05T00:00:00Z',
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('shows review-requested PRs without notifications and excludes approved or changes-requested PRs', async ({
    page,
  }) => {
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');

    await page.locator('#view-others-prs').click();
    const stateFilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    await expect(stateFilters.locator('[data-subfilter="needs-review"] .count')).toHaveText('1');
    await expect(stateFilters.locator('[data-subfilter="approved"] .count')).toHaveText('1');

    await stateFilters.locator('[data-subfilter="needs-review"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="review-request:test/repo#10"]')).toBeVisible();
    await expect(page.locator('[data-id="review-request:test/repo#11"]')).not.toBeAttached();
    await expect(page.locator('[data-id="review-request:test/repo#12"]')).not.toBeAttached();
  });

  test('remove me exits a synthetic responsibility item without notification actions', async ({
    page,
  }) => {
    let removeReviewerCalled = false;
    let notificationActionCalled = false;

    await page.route('**/github/rest/repos/test/repo/pulls/10/requested_reviewers', (route) => {
      removeReviewerCalled = true;
      route.fulfill({ status: 204 });
    });
    await page.route('**/notifications/html/action', (route) => {
      notificationActionCalled = true;
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic rows should not call this' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');

    await page.locator('#view-others-prs').click();
    const stateFilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    await stateFilters.locator('[data-subfilter="needs-review"]').click();
    const item = page.locator('[data-id="review-request:test/repo#10"]');
    await expect(item).toBeVisible();

    await item.locator('.notification-actions-inline .notification-remove-reviewer-btn').click();
    await expect(item).not.toBeAttached();
    expect(removeReviewerCalled).toBe(true);
    expect(notificationActionCalled).toBe(false);
  });
});
