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
      id: 'thread-pr-1',
      unread: true,
      reason: 'review_requested',
      updated_at: '2025-01-02T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Needs review PR',
        url: 'https://github.com/test/repo/pull/1',
        type: 'PullRequest',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [],
      ui: { saved: false, done: false },
    },
    {
      id: 'thread-pr-2',
      unread: true,
      reason: 'review_requested',
      updated_at: '2025-01-03T00:00:00Z',
      last_read_at: '2025-01-01T00:00:00Z',
      subject: {
        title: 'Approved PR',
        url: 'https://github.com/test/repo/pull/2',
        type: 'PullRequest',
        number: 2,
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

test.describe('Triage queues', () => {
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
        'thread-pr-1': {
          notificationUpdatedAt: notificationsResponse.notifications[0].updated_at,
          lastReadAt: notificationsResponse.notifications[0].last_read_at,
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [],
          reviews: [],
        },
        'thread-pr-2': {
          notificationUpdatedAt: notificationsResponse.notifications[1].updated_at,
          lastReadAt: notificationsResponse.notifications[1].last_read_at,
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [],
          reviews: [
            {
              id: 101,
              state: 'APPROVED',
              submitted_at: '2025-01-02T12:00:00Z',
              user: { login: 'reviewer1' },
            },
          ],
        },
      },
    };

    await page.addInitScript((cache) => {
      localStorage.setItem('ghnotif_comment_prefetch_enabled', 'true');
      localStorage.setItem('ghnotif_bulk_comment_cache_v1', JSON.stringify(cache));
    }, commentCache);

    await page.goto('notifications.html');
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
  });

  test('routes PRs without comments to needs review', async ({ page }) => {
    // Switch to Others' PRs view
    await page.locator('#view-others-prs').click();

    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
    await expect(othersPrsSubfilters.locator('[data-subfilter="needs-review"] .count')).toHaveText('1');
    await expect(othersPrsSubfilters.locator('[data-subfilter="approved"] .count')).toHaveText('1');

    // needs-review is the default subfilter for others-prs
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('[data-id="thread-pr-1"]')).toBeVisible();
    await expect(page.locator('.comment-tag.needs-review')).toHaveText('Needs review');
  });

  test('approved queue allows unsubscribe', async ({ page }) => {
    let unsubscribeCalled = false;
    let markDoneCalled = false;
    await page.route(
      '**/github/rest/notifications/threads/thread-pr-2/subscription',
      (route) => {
        unsubscribeCalled = route.request().method() === 'DELETE';
        route.fulfill({ status: 204, body: '' });
      }
    );
    await page.route('**/github/rest/notifications/threads/thread-pr-2', (route) => {
      markDoneCalled = route.request().method() === 'DELETE';
      route.fulfill({ status: 204, body: '' });
    });

    // Switch to Others' PRs view and approved subfilter
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    await page
      .locator('[data-id="thread-pr-2"] .notification-actions-inline .notification-unsubscribe-btn')
      .click();
    await expect(page.locator('#status-bar')).toContainText(
      'Unsubscribed and marked 1 notification as done'
    );
    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(unsubscribeCalled).toBe(true);
    expect(markDoneCalled).toBe(true);
  });

  test('approved queue shows bottom unsubscribe when comments are expanded', async ({
    page,
  }) => {
    let unsubscribeCalled = false;
    let markDoneCalled = false;
    await page.route(
      '**/github/rest/notifications/threads/thread-pr-2/subscription',
      (route) => {
        unsubscribeCalled = route.request().method() === 'DELETE';
        route.fulfill({ status: 204, body: '' });
      }
    );
    await page.route('**/github/rest/notifications/threads/thread-pr-2', (route) => {
      markDoneCalled = route.request().method() === 'DELETE';
      route.fulfill({ status: 204, body: '' });
    });

    await page.locator('#comment-expand-toggle').check();
    // Switch to Others' PRs view and approved subfilter
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    const bottomUnsubscribeButton = page.locator(
      '[data-id="thread-pr-2"] .notification-unsubscribe-btn-bottom'
    );
    await expect(bottomUnsubscribeButton).toBeVisible();

    await bottomUnsubscribeButton.click();

    await expect(page.locator('#status-bar')).toContainText(
      'Unsubscribed and marked 1 notification as done'
    );
    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(unsubscribeCalled).toBe(true);
    expect(markDoneCalled).toBe(true);
  });

  test('approved queue shows Unsubscribe All button when nothing is selected', async ({
    page,
  }) => {
    // Switch to Others' PRs view and approved subfilter
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    // Button should be visible when nothing is selected
    const unsubscribeAllBtn = page.locator('#unsubscribe-all-btn');
    await expect(unsubscribeAllBtn).toBeVisible();
    await expect(unsubscribeAllBtn).toHaveText('Unsubscribe from all');

    // Button should be hidden when an item is selected
    await page.locator('[data-id="thread-pr-2"] .notification-checkbox').click();
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Button reappears when selection is cleared
    await page.locator('[data-id="thread-pr-2"] .notification-checkbox').click();
    await expect(unsubscribeAllBtn).toBeVisible();
  });

  test('Unsubscribe All button unsubscribes all approved notifications', async ({ page }) => {
    let unsubscribeCalled = false;
    let markDoneCalled = false;
    await page.route(
      '**/github/rest/notifications/threads/thread-pr-2/subscription',
      (route) => {
        unsubscribeCalled = route.request().method() === 'DELETE';
        route.fulfill({ status: 204, body: '' });
      }
    );
    await page.route('**/github/rest/notifications/threads/thread-pr-2', (route) => {
      markDoneCalled = route.request().method() === 'DELETE';
      route.fulfill({ status: 204, body: '' });
    });

    // Switch to Others' PRs view and approved subfilter
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(page.locator('[data-id="thread-pr-2"]')).toBeVisible();

    await page.locator('#unsubscribe-all-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Unsubscribed from 1 notification');
    await expect(page.locator('[data-id="thread-pr-2"]')).not.toBeAttached();
    expect(unsubscribeCalled).toBe(true);
    expect(markDoneCalled).toBe(true);
  });

  test('Unsubscribe All button is not visible in non-approved filters', async ({ page }) => {
    const unsubscribeAllBtn = page.locator('#unsubscribe-all-btn');

    // Not visible in Issues view (default)
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Switch to Others' PRs view
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');

    // Not visible in Needs Review subfilter (default for Others' PRs)
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Not visible in Closed subfilter
    await othersPrsSubfilters.locator('[data-subfilter="closed"]').click();
    await expect(unsubscribeAllBtn).not.toBeVisible();

    // Visible in Approved subfilter
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(unsubscribeAllBtn).toBeVisible();
  });
});

