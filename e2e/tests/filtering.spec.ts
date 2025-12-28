import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';

/**
 * Phase 5: Filtering Tests
 *
 * Tests for filtering notifications by state (all, open, closed).
 */

test.describe('Filtering', () => {
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
        body: JSON.stringify(mixedFixture),
      });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => localStorage.clear());
  });

  test.describe('Filter Tabs', () => {
    test('displays all filter tabs', async ({ page }) => {
      const allTab = page.locator('#filter-all');
      const openTab = page.locator('#filter-open');
      const closedTab = page.locator('#filter-closed');
      const needsReviewTab = page.locator('#filter-needs-review');
      const approvedTab = page.locator('#filter-approved');
      const uninterestingTab = page.locator('#filter-uninteresting');

      await expect(allTab).toBeVisible();
      await expect(openTab).toBeVisible();
      await expect(closedTab).toBeVisible();
      await expect(needsReviewTab).toBeVisible();
      await expect(approvedTab).toBeVisible();
      await expect(uninterestingTab).toBeVisible();
    });

    test('All tab is active by default', async ({ page }) => {
      const allTab = page.locator('#filter-all');
      await expect(allTab).toHaveClass(/active/);
      await expect(allTab).toHaveAttribute('aria-selected', 'true');
    });

    test('Open and Closed tabs are not active by default', async ({ page }) => {
      const openTab = page.locator('#filter-open');
      const closedTab = page.locator('#filter-closed');

      await expect(openTab).not.toHaveClass(/active/);
      await expect(closedTab).not.toHaveClass(/active/);
      await expect(openTab).toHaveAttribute('aria-selected', 'false');
      await expect(closedTab).toHaveAttribute('aria-selected', 'false');
    });

    test('filter tabs have role="tab"', async ({ page }) => {
      const tabs = page.locator('.filter-tab');
      const count = await tabs.count();

      for (let i = 0; i < count; i++) {
        await expect(tabs.nth(i)).toHaveAttribute('role', 'tab');
      }
    });

    test('filter tabs container has role="tablist"', async ({ page }) => {
      const tablist = page.locator('.filter-tabs');
      await expect(tablist).toHaveAttribute('role', 'tablist');
    });
  });

  test.describe('Type Filter', () => {
    test('displays type filter buttons', async ({ page }) => {
      await expect(page.locator('#type-filter-all')).toBeVisible();
      await expect(page.locator('#type-filter-issue')).toBeVisible();
      await expect(page.locator('#type-filter-pull')).toBeVisible();
    });

    test('filters to issues only', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

      await page.locator('#type-filter-issue').click();

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
    });

    test('filters to pull requests only', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

      await page.locator('#type-filter-pull').click();

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(2);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-1"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-3"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-5"]')).not.toBeAttached();
    });
  });

  test.describe('Filter Counts', () => {
    test('shows 0 counts before sync', async ({ page }) => {
      const countAll = page.locator('#count-all');
      const countOpen = page.locator('#count-open');
      const countClosed = page.locator('#count-closed');
      const countNeedsReview = page.locator('#count-needs-review');
      const countApproved = page.locator('#count-approved');
      const countUninteresting = page.locator('#count-uninteresting');

      await expect(countAll).toHaveText('0');
      await expect(countOpen).toHaveText('0');
      await expect(countClosed).toHaveText('0');
      await expect(countNeedsReview).toHaveText('0');
      await expect(countApproved).toHaveText('0');
      await expect(countUninteresting).toHaveText('0');
    });

    test('updates counts after sync', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();

      // Wait for sync to complete
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

      const countAll = page.locator('#count-all');
      const countOpen = page.locator('#count-open');
      const countClosed = page.locator('#count-closed');
      const countNeedsReview = page.locator('#count-needs-review');
      const countApproved = page.locator('#count-approved');
      const countUninteresting = page.locator('#count-uninteresting');

      // 5 total, 2 open (open issue + open PR), 3 closed (closed issue + merged PR + not_planned issue)
      await expect(countAll).toHaveText('5');
      await expect(countOpen).toHaveText('2');
      await expect(countClosed).toHaveText('3');
      await expect(countNeedsReview).toHaveText('0');
      await expect(countApproved).toHaveText('0');
      await expect(countUninteresting).toHaveText('0');
    });

    test('updates counts when type filter is applied', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();

      // Wait for sync to complete
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

      await page.locator('#type-filter-issue').click();

      const countAll = page.locator('#count-all');
      const countOpen = page.locator('#count-open');
      const countClosed = page.locator('#count-closed');
      const countNeedsReview = page.locator('#count-needs-review');
      const countApproved = page.locator('#count-approved');
      const countUninteresting = page.locator('#count-uninteresting');

      // 3 issues total, 1 open, 2 closed
      await expect(countAll).toHaveText('3');
      await expect(countOpen).toHaveText('1');
      await expect(countClosed).toHaveText('2');
      await expect(countNeedsReview).toHaveText('0');
      await expect(countApproved).toHaveText('0');
      await expect(countUninteresting).toHaveText('0');
    });
  });

  test.describe('Filter Switching', () => {
    test.beforeEach(async ({ page }) => {
      // Sync first
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('clicking Open tab filters to open notifications', async ({ page }) => {
      await page.locator('#filter-open').click();

      // Check tab states
      await expect(page.locator('#filter-open')).toHaveClass(/active/);
      await expect(page.locator('#filter-all')).not.toHaveClass(/active/);

      // Check only open items are shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(2);

      // Verify the open items are shown
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();

      // Verify closed items are hidden
      await expect(page.locator('[data-id="notif-3"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-5"]')).not.toBeAttached();
    });

    test('clicking Closed tab filters to closed notifications', async ({ page }) => {
      await page.locator('#filter-closed').click();

      // Check tab states
      await expect(page.locator('#filter-closed')).toHaveClass(/active/);
      await expect(page.locator('#filter-all')).not.toHaveClass(/active/);

      // Check only closed items are shown (closed, merged, not_planned)
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);

      // Verify the closed items are shown
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();

      // Verify open items are hidden
      await expect(page.locator('[data-id="notif-1"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
    });

    test('clicking All tab shows all notifications', async ({ page }) => {
      // First switch to open
      await page.locator('#filter-open').click();
      await expect(page.locator('.notification-item')).toHaveCount(2);

      // Then switch back to all
      await page.locator('#filter-all').click();

      // Check tab state
      await expect(page.locator('#filter-all')).toHaveClass(/active/);

      // Check all items are shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(5);
    });

    test('notification count header updates with filter', async ({ page }) => {
      const countHeader = page.locator('#notification-count');

      // All shows 5
      await expect(countHeader).toHaveText('5 notifications');

      // Open shows 2
      await page.locator('#filter-open').click();
      await expect(countHeader).toHaveText('2 notifications');

      // Closed shows 3
      await page.locator('#filter-closed').click();
      await expect(countHeader).toHaveText('3 notifications');
    });

    test('filter tab counts remain constant when switching filters', async ({ page }) => {
      // Counts should always show totals, not filtered counts
      await page.locator('#filter-open').click();

      await expect(page.locator('#count-all')).toHaveText('5');
      await expect(page.locator('#count-open')).toHaveText('2');
      await expect(page.locator('#count-closed')).toHaveText('3');
      await expect(page.locator('#count-needs-review')).toHaveText('0');
      await expect(page.locator('#count-approved')).toHaveText('0');

      await page.locator('#filter-closed').click();

      await expect(page.locator('#count-all')).toHaveText('5');
      await expect(page.locator('#count-open')).toHaveText('2');
      await expect(page.locator('#count-closed')).toHaveText('3');
      await expect(page.locator('#count-needs-review')).toHaveText('0');
      await expect(page.locator('#count-approved')).toHaveText('0');
    });
  });

  test.describe('Filter Persistence', () => {
    test('saves filter preference to localStorage', async ({ page }) => {
      // Sync first
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Change filter
      await page.locator('#filter-closed').click();

      // Check localStorage
      const savedFilter = await page.evaluate(() =>
        localStorage.getItem('ghnotif_filter')
      );
      expect(savedFilter).toBe('closed');
    });

    test('restores filter preference on page load', async ({ page }) => {
      // Set filter in localStorage
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_filter', 'open');
      });

      // Reload
      await page.reload();

      // Check that Open tab is active
      await expect(page.locator('#filter-open')).toHaveClass(/active/);
      await expect(page.locator('#filter-all')).not.toHaveClass(/active/);
    });

    test('saves type filter preference to localStorage', async ({ page }) => {
      await page.locator('#type-filter-pull').click();
      const savedFilter = await page.evaluate(() =>
        localStorage.getItem('ghnotif_type_filter')
      );
      expect(savedFilter).toBe('pull');
    });

    test('restores type filter preference on page load', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_type_filter', 'issue');
      });

      await page.reload();

      await expect(page.locator('#type-filter-issue')).toHaveClass(/active/);
      await expect(page.locator('#type-filter-all')).not.toHaveClass(/active/);
    });

    test('restores filter and applies to loaded notifications', async ({ page }) => {
      // Set filter and notifications in localStorage
      await page.evaluate((notifications) => {
        localStorage.setItem('ghnotif_filter', 'closed');
        localStorage.setItem('ghnotif_notifications', JSON.stringify(notifications));
      }, mixedFixture.notifications);

      // Reload
      await page.reload();

      // Check that Closed tab is active
      await expect(page.locator('#filter-closed')).toHaveClass(/active/);

      // Check only closed notifications are shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);
    });

    test('ignores invalid filter values in localStorage', async ({ page }) => {
      // Set invalid filter
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_filter', 'invalid');
      });

      // Reload
      await page.reload();

      // Should default to All
      await expect(page.locator('#filter-all')).toHaveClass(/active/);
    });
  });

  test.describe('Empty State with Filters', () => {
    test('shows empty state when filter has no results', async ({ page }) => {
      // Create fixture with only open notifications
      const onlyOpenFixture = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.filter(
          (n) => n.subject.state === 'open'
        ),
      };

      // Re-mock with only open notifications
      await page.route(
        '**/notifications/html/repo/**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(onlyOpenFixture),
          });
        },
        { times: 1 }
      );

      // Sync
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to closed filter
      await page.locator('#filter-closed').click();

      // Should show empty state
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toBeVisible();
    });

    test('empty state hidden when filter has results', async ({ page }) => {
      // Sync
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch between filters - all should have results
      for (const filter of ['all', 'open', 'closed']) {
        await page.locator(`#filter-${filter}`).click();
        await expect(page.locator('#empty-state')).not.toBeVisible();
      }
    });
  });

  test.describe('Filter with Draft PRs', () => {
    test('draft PRs are included in Open filter', async ({ page }) => {
      // Create fixture with a draft PR
      const withDraftFixture = {
        ...mixedFixture,
        notifications: [
          ...mixedFixture.notifications,
          {
            id: 'notif-draft',
            unread: true,
            reason: 'review_requested',
            updated_at: '2024-12-27T12:00:00Z',
            subject: {
              title: 'Draft: Work in progress',
              url: 'https://github.com/test/repo/pull/50',
              type: 'PullRequest',
              number: 50,
              state: 'draft',
              state_reason: null,
            },
            actors: [],
            ui: { saved: false, done: false },
          },
        ],
      };

      // Re-mock with draft PR
      await page.route(
        '**/notifications/html/repo/**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(withDraftFixture),
          });
        },
        { times: 1 }
      );

      // Sync
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 6 notifications');

      // Check counts - draft should be in open
      await expect(page.locator('#count-open')).toHaveText('3');

      // Switch to open filter
      await page.locator('#filter-open').click();

      // Draft PR should be visible
      await expect(page.locator('[data-id="notif-draft"]')).toBeVisible();
    });
  });

  test.describe('Filter with Merged PRs', () => {
    test('merged PRs are included in Closed filter', async ({ page }) => {
      // Sync (mixed fixture already has merged PR notif-4)
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to closed filter
      await page.locator('#filter-closed').click();

      // Merged PR should be visible
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });
  });
});
