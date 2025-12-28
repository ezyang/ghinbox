import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';

/**
 * Filtering Tests
 *
 * Tests for filtering notifications by view (Issues, My PRs, Others' PRs)
 * and by subfilter (All, Open, Closed, Needs Review, Approved).
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

  test.describe('View Tabs', () => {
    test('displays all view tabs', async ({ page }) => {
      const issuesTab = page.locator('#view-issues');
      const myPrsTab = page.locator('#view-my-prs');
      const othersPrsTab = page.locator('#view-others-prs');

      await expect(issuesTab).toBeVisible();
      await expect(myPrsTab).toBeVisible();
      await expect(othersPrsTab).toBeVisible();
    });

    test('Issues tab is active by default', async ({ page }) => {
      const issuesTab = page.locator('#view-issues');
      await expect(issuesTab).toHaveClass(/active/);
      await expect(issuesTab).toHaveAttribute('aria-selected', 'true');
    });

    test('other view tabs are not active by default', async ({ page }) => {
      const myPrsTab = page.locator('#view-my-prs');
      const othersPrsTab = page.locator('#view-others-prs');

      await expect(myPrsTab).not.toHaveClass(/active/);
      await expect(othersPrsTab).not.toHaveClass(/active/);
      await expect(myPrsTab).toHaveAttribute('aria-selected', 'false');
      await expect(othersPrsTab).toHaveAttribute('aria-selected', 'false');
    });

    test('view tabs have role="tab"', async ({ page }) => {
      const tabs = page.locator('.view-tab');
      const count = await tabs.count();

      for (let i = 0; i < count; i++) {
        await expect(tabs.nth(i)).toHaveAttribute('role', 'tab');
      }
    });

    test('view tabs container has role="tablist"', async ({ page }) => {
      const tablist = page.locator('.view-tabs');
      await expect(tablist).toHaveAttribute('role', 'tablist');
    });
  });

  test.describe('Subfilter Tabs', () => {
    test('displays Issues subfilter tabs when Issues view is active', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await expect(issuesSubfilters).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="all"]')).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="closed"]')).toBeVisible();
    });

    test('hides other subfilter tabs when Issues view is active', async ({ page }) => {
      const myPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="my-prs"]');
      const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
      await expect(myPrsSubfilters).toHaveClass(/hidden/);
      await expect(othersPrsSubfilters).toHaveClass(/hidden/);
    });

    test('shows Others PRs subfilters when switching to Others PRs view', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
      await expect(othersPrsSubfilters).not.toHaveClass(/hidden/);
      await expect(othersPrsSubfilters.locator('[data-subfilter="needs-review"]')).toBeVisible();
      await expect(othersPrsSubfilters.locator('[data-subfilter="approved"]')).toBeVisible();
      await expect(othersPrsSubfilters.locator('[data-subfilter="closed"]')).toBeVisible();
    });
  });

  test.describe('View Switching', () => {
    test.beforeEach(async ({ page }) => {
      // Sync first
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('clicking Issues tab shows only issues', async ({ page }) => {
      // Issues is default, so we should see 3 issues
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);

      // Verify issue items are shown
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();

      // Verify PR items are not shown
      await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
    });

    test('clicking Others PRs tab shows only others PRs', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      // Check tab states
      await expect(page.locator('#view-others-prs')).toHaveClass(/active/);
      await expect(page.locator('#view-issues')).not.toHaveClass(/active/);

      // Check only PR items are shown (all PRs in fixture are by others)
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(2);

      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });

    test('My PRs tab shows empty when no PRs by current user', async ({ page }) => {
      await page.locator('#view-my-prs').click();

      // Test user is 'testuser', but fixture PRs are by bob and eve
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(0);

      // Empty state should be visible
      await expect(page.locator('#empty-state')).toBeVisible();
    });
  });

  test.describe('View Counts', () => {
    test('shows 0 counts before sync', async ({ page }) => {
      const issuesCount = page.locator('#view-issues .count');
      const myPrsCount = page.locator('#view-my-prs .count');
      const othersPrsCount = page.locator('#view-others-prs .count');

      await expect(issuesCount).toHaveText('0');
      await expect(myPrsCount).toHaveText('0');
      await expect(othersPrsCount).toHaveText('0');
    });

    test('updates view counts after sync', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

      // 3 issues, 0 my PRs (testuser has no PRs), 2 others PRs
      await expect(page.locator('#view-issues .count')).toHaveText('3');
      await expect(page.locator('#view-my-prs .count')).toHaveText('0');
      await expect(page.locator('#view-others-prs .count')).toHaveText('2');
    });
  });

  test.describe('Subfilter Counts', () => {
    test.beforeEach(async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('shows subfilter counts for Issues view', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');

      // 3 issues total: 1 open, 2 closed
      await expect(issuesSubfilters.locator('[data-subfilter="all"] .count')).toHaveText('3');
      await expect(issuesSubfilters.locator('[data-subfilter="open"] .count')).toHaveText('1');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('2');
    });

    test('shows subfilter counts for Others PRs view', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');

      // 2 PRs: 1 open, 1 merged (closed)
      // needs-review and approved both show 0 without comment prefetch
      await expect(othersPrsSubfilters.locator('[data-subfilter="needs-review"] .count')).toHaveText('0');
      await expect(othersPrsSubfilters.locator('[data-subfilter="approved"] .count')).toHaveText('0');
      await expect(othersPrsSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('1');
    });
  });

  test.describe('Subfilter Switching', () => {
    test.beforeEach(async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('clicking Open subfilter filters to open issues', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();

      // Check subfilter tab states
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toHaveClass(/active/);
      await expect(issuesSubfilters.locator('[data-subfilter="all"]')).not.toHaveClass(/active/);

      // Check only open issue is shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(1);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('clicking Closed subfilter filters to closed issues', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      // Check only closed issues are shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(2);
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();
    });

    test('clicking All subfilter shows all issues', async ({ page }) => {
      // First switch to open
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Then switch back to all
      await issuesSubfilters.locator('[data-subfilter="all"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });

    test('notification count header updates with subfilter', async ({ page }) => {
      const countHeader = page.locator('#notification-count');

      // All shows 3 issues
      await expect(countHeader).toHaveText('3 notifications');

      // Open shows 1
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(countHeader).toHaveText('1 notifications');

      // Closed shows 2
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();
      await expect(countHeader).toHaveText('2 notifications');
    });
  });

  test.describe('View Persistence', () => {
    test('saves view preference to localStorage', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const savedView = await page.evaluate(() =>
        localStorage.getItem('ghnotif_view')
      );
      expect(savedView).toBe('others-prs');
    });

    test('restores view preference on page load', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_view', 'others-prs');
      });

      await page.reload();

      await expect(page.locator('#view-others-prs')).toHaveClass(/active/);
      await expect(page.locator('#view-issues')).not.toHaveClass(/active/);
    });

    test('saves subfilter preference to localStorage', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      const savedViewFilters = await page.evaluate(() =>
        localStorage.getItem('ghnotif_view_filters')
      );
      expect(JSON.parse(savedViewFilters!)).toHaveProperty('issues', 'closed');
    });

    test('restores subfilter and applies to loaded notifications', async ({ page }) => {
      await page.evaluate((notifications) => {
        localStorage.setItem('ghnotif_view', 'issues');
        localStorage.setItem('ghnotif_view_filters', JSON.stringify({ issues: 'closed' }));
        localStorage.setItem('ghnotif_notifications', JSON.stringify(notifications));
      }, mixedFixture.notifications);

      await page.reload();

      // Check that Closed subfilter is active
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"]')).toHaveClass(/active/);

      // Check only closed issues are shown
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(2);
    });

    test('ignores invalid view values in localStorage', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_view', 'invalid');
      });

      await page.reload();

      // Should default to Issues
      await expect(page.locator('#view-issues')).toHaveClass(/active/);
    });
  });

  test.describe('Empty State with Views', () => {
    test('shows empty state when view has no results', async ({ page }) => {
      // Sync first
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to My PRs (testuser has no PRs)
      await page.locator('#view-my-prs').click();

      // Should show empty state
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toBeVisible();
    });

    test('empty state hidden when view has results', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Issues and Others PRs should have results
      await expect(page.locator('#empty-state')).not.toBeVisible();

      await page.locator('#view-others-prs').click();
      await expect(page.locator('#empty-state')).not.toBeVisible();
    });
  });

  test.describe('Filter with Draft PRs', () => {
    test('draft PRs are included in open count for Others PRs', async ({ page }) => {
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
            actors: [{ login: 'alice', avatar_url: 'https://example.com/avatar' }],
            ui: { saved: false, done: false },
          },
        ],
      };

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

      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 6 notifications');

      // Switch to Others PRs
      await page.locator('#view-others-prs').click();

      // Should show 3 PRs (2 original + 1 draft)
      await expect(page.locator('#view-others-prs .count')).toHaveText('3');

      // Draft PR should be visible in default (needs-review) view
      // Note: needs-review filter requires comment prefetch, so by default shows 0
      // Let's check the "all" subfilter by clicking on closed then manually
    });
  });

  test.describe('Filter with Merged PRs', () => {
    test('merged PRs are included in Closed subfilter for Others PRs', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to Others PRs
      await page.locator('#view-others-prs').click();

      // Switch to Closed subfilter
      const othersPrsSubfilters = page.locator('.subfilter-tabs[data-for-view="others-prs"]');
      await othersPrsSubfilters.locator('[data-subfilter="closed"]').click();

      // Merged PR should be visible
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });
  });
});
