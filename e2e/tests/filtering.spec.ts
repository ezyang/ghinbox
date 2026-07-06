import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, seedNotificationsCache } from './storage-utils';
import {
  mockDefaultApiRoutes,
  openNotificationsApp,
  openNotificationsWithCachedData,
} from './app-fixture';

async function waitForStatusClear(page) {
  const statusBar = page.locator('#status-bar');
  await expect(statusBar).toHaveText('', { timeout: 10000 });
}

async function expectNoStatusFlash(page, text) {
  const statusBar = page.locator('#status-bar');
  // Assert the text does not appear within a short observation window.
  // not.toContainText auto-retries: it keeps checking until the timeout
  // passes without the text ever appearing. Using a short timeout so the
  // test fails fast if the text does show up.
  await expect(statusBar).not.toContainText(text, { timeout: 1200 });
}

/**
 * Filtering Tests
 *
 * Tests for filtering notifications by queue (Feed, Replies, Reviews)
 * and by subfilter (All, Open, Closed, PRs, Issues, Needs Review, Approved, Committers, AI, External).
 */

test.describe('Filtering @classification', () => {
  test.beforeEach(async ({ page }) => {
    await mockDefaultApiRoutes(page);
    await openNotificationsApp(page);
    await clearAppStorage(page);
  });

  test('sync prefetches comments even when comments are collapsed', async ({ page }) => {
    let graphqlCount = 0;
    let commentCount = 0;
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/github/graphql')) {
        graphqlCount += 1;
      }
      if (url.includes('/github/rest/repos/') && url.includes('/issues/') && url.includes('/comments')) {
        commentCount += 1;
      }
    });

    const input = page.locator('#repo-input');
    await input.fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(4);

    await expect.poll(() => graphqlCount, { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => commentCount, { timeout: 5000 }).toBeGreaterThan(0);
  });

  test.describe('View Tabs', () => {
    test('displays all view tabs', async ({ page }) => {
      await expect(page.locator('#view-issues')).toContainText('Feed');
      await expect(page.locator('#view-pr-notifications')).toContainText('Replies');
      await expect(page.locator('#view-others-prs')).toContainText('Reviews');
      await expect(page.locator('#view-cleaned')).toContainText('Cleaned');
    });

    test('Feed tab is active by default', async ({ page }) => {
      const issuesTab = page.locator('#view-issues');
      await expect(issuesTab).toHaveClass(/active/);
      await expect(issuesTab).toHaveAttribute('aria-selected', 'true');
    });

    test('other view tabs are not active by default', async ({ page }) => {
      const repliesTab = page.locator('#view-pr-notifications');
      const othersPrsTab = page.locator('#view-others-prs');

      await expect(repliesTab).not.toHaveClass(/active/);
      await expect(othersPrsTab).not.toHaveClass(/active/);
      await expect(repliesTab).toHaveAttribute('aria-selected', 'false');
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
    test('displays Feed subfilter tabs when Feed view is active', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]');
      await expect(issuesSubfilters).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="closed"]')).toBeVisible();
    });

    test('displays Feed type subfilter tabs when Feed view is active', async ({ page }) => {
      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');
      await expect(typeSubfilters).toBeVisible();
      await expect(typeSubfilters.locator('[data-subfilter="prs"]')).toBeVisible();
      await expect(typeSubfilters.locator('[data-subfilter="issues"]')).toBeVisible();
    });

    test('hides other subfilter tabs when Feed view is active', async ({ page }) => {
      const othersPrsSubfilters = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      await expect(page.locator('.subfilter-tabs[data-for-view="pr-notifications"][data-subfilter-group="state"]')).toHaveClass(/hidden/);
      await expect(othersPrsSubfilters).toHaveClass(/hidden/);
    });

    test('shows Reviews subfilters when switching to Reviews view', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const othersPrsStatus = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      const othersPrsAuthor = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );
      await expect(othersPrsStatus).not.toHaveClass(/hidden/);
      await expect(othersPrsAuthor).not.toHaveClass(/hidden/);
      await expect(othersPrsStatus.locator('[data-subfilter="needs-review"]')).toBeVisible();
      await expect(othersPrsStatus.locator('[data-subfilter="approved"]')).toBeVisible();
      await expect(othersPrsStatus.locator('[data-subfilter="done"]')).toBeVisible();
      await expect(othersPrsStatus.locator('[data-subfilter="draft"]')).toHaveCount(0);
      await expect(othersPrsStatus.locator('[data-subfilter="closed"]')).toHaveCount(0);
      await expect(othersPrsAuthor.locator('[data-subfilter="committer"]')).toBeVisible();
      await expect(othersPrsAuthor.locator('.subfilter-tab')).toHaveText([
        /Committers\s+0/,
        /AI\s+0/,
        /External\s+0/,
      ]);
      await expect(othersPrsAuthor.locator('[data-subfilter="ai"]')).toBeVisible();
      await expect(othersPrsAuthor.locator('[data-subfilter="external"]')).toBeVisible();
    });

    test('subfilter divider stays within the notifications container', async ({ page }) => {
      const container = page.locator('.notifications-container');
      const viewTabs = page.locator('.view-tabs');
      const subfilterTabs = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]');

      await expect(container).toBeVisible();
      await expect(viewTabs).toBeVisible();
      await expect(subfilterTabs).toBeVisible();

      const [containerBox, viewBox, subfilterBox] = await Promise.all([
        container.boundingBox(),
        viewTabs.boundingBox(),
        subfilterTabs.boundingBox(),
      ]);

      expect(containerBox).not.toBeNull();
      expect(viewBox).not.toBeNull();
      expect(subfilterBox).not.toBeNull();

      const tolerance = 0.5;
      const containerLeft = containerBox!.x;
      const containerRight = containerBox!.x + containerBox!.width;

      expect(viewBox!.x).toBeGreaterThanOrEqual(containerLeft - tolerance);
      expect(viewBox!.x + viewBox!.width).toBeLessThanOrEqual(containerRight + tolerance);
      expect(subfilterBox!.x).toBeGreaterThanOrEqual(containerLeft - tolerance);
      expect(subfilterBox!.x + subfilterBox!.width).toBeLessThanOrEqual(containerRight + tolerance);
    });
  });

  test.describe('View Switching', () => {
    test.beforeEach(async ({ page }) => {
      await openNotificationsWithCachedData(page);
    });

    test('clicking Feed tab shows awareness notifications', async ({ page }) => {
      // Feed is default, so we should see issues plus non-directed PR notifications.
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(4);

      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();

      await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
    });

    test('clicking Reviews tab shows review responsibility', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      // Check tab states
      await expect(page.locator('#view-others-prs')).toHaveClass(/active/);
      await expect(page.locator('#view-issues')).not.toHaveClass(/active/);

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(1);

      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
    });

    test('Replies tab shows empty when nothing is directed at the current user', async ({ page }) => {
      await page.locator('#view-pr-notifications').click();

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(0);

      // Empty state should be visible
      await expect(page.locator('#empty-state')).toBeVisible();
    });
  });

  test.describe('View Counts', () => {
    test('shows 0 counts before sync', async ({ page }) => {
      const issuesCount = page.locator('#view-issues .count');
      const repliesCount = page.locator('#view-pr-notifications .count');
      const othersPrsCount = page.locator('#view-others-prs .count');

      await expect(issuesCount).toHaveText('0');
      await expect(repliesCount).toHaveText('0');
      await expect(othersPrsCount).toHaveText('0');
    });

    test('updates view counts after sync', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();

      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(4);

      await expect(page.locator('#view-issues .count')).toHaveText('4');
      await expect(page.locator('#view-pr-notifications .count')).toHaveText('0');
      await expect(page.locator('#view-others-prs .count')).toHaveText('1');
    });
  });

  test.describe('Subfilter Counts', () => {
    test.beforeEach(async ({ page }) => {
      await openNotificationsWithCachedData(page);
    });

    test('shows subfilter counts for Feed view', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');

      // 4 feed items total: 1 open, 3 closed/merged
      await expect(issuesSubfilters.locator('[data-subfilter="open"] .count')).toHaveText('1');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('3');
    });

    test('shows PR and issue counts for Feed view', async ({ page }) => {
      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');

      await expect(typeSubfilters.locator('[data-subfilter="prs"] .count')).toHaveText('1');
      await expect(typeSubfilters.locator('[data-subfilter="issues"] .count')).toHaveText('3');
    });

    test('hides count on the active subfilter', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');

      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(issuesSubfilters.locator('[data-subfilter="open"] .count')).toHaveText('');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('3');
    });

    test('shows subfilter counts for Reviews view', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const othersPrsStatus = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      const othersPrsAuthor = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );

      await expect(othersPrsStatus.locator('[data-subfilter="needs-review"] .count')).toHaveText('1');
      await expect(othersPrsStatus.locator('[data-subfilter="approved"] .count')).toHaveText('0');
      await expect(othersPrsStatus.locator('[data-subfilter="done"] .count')).toHaveText('0');
      await expect(othersPrsAuthor.locator('[data-subfilter="committer"] .count')).toHaveText('0');
      await expect(othersPrsAuthor.locator('[data-subfilter="ai"] .count')).toHaveText('0');
      await expect(othersPrsAuthor.locator('[data-subfilter="external"] .count')).toHaveText('0');
    });
  });

  test.describe('Author Filters', () => {
    test('filters Reviews by author category', async ({ page }) => {
      await page.route('**/github/rest/rate_limit', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            resources: {
              core: {
                limit: 5000,
                remaining: 4999,
                reset: Math.floor(Date.now() / 1000) + 3600,
              },
            },
          }),
        });
      });
      await page.route('**/github/graphql', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              rateLimit: {
                limit: 5000,
                remaining: 4999,
                resetAt: new Date().toISOString(),
              },
              repository: {
                pr43: {
                  reviewDecision: null,
                  authorAssociation: 'COLLABORATOR',
                  author: { login: 'jansel' },
                },
                pr40: {
                  reviewDecision: null,
                  authorAssociation: 'MEMBER',
                  author: { login: 'orgmember' },
                },
              },
            },
          }),
        });
      });
      await page.route('**/github/rest/repos/test/repo/collaborators/jansel/permission', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ permission: 'write', role_name: 'write' }),
        });
      });
      await page.route('**/github/rest/repos/test/repo/collaborators/orgmember/permission', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ permission: 'read', role_name: 'read' }),
        });
      });

      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(4);
      await waitForStatusClear(page);
      await page.locator('#view-others-prs').click();

      const othersPrsStatus = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      const othersPrsAuthor = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );
      await expect(othersPrsAuthor.locator('[data-subfilter="ai"] .count')).toHaveText('1');
      await expect(othersPrsAuthor.locator('[data-subfilter="committer"] .count')).toHaveText('0');
      await othersPrsAuthor.locator('[data-subfilter="committer"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(0);
      await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();

      await othersPrsAuthor.locator('[data-subfilter="ai"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(othersPrsAuthor.locator('[data-subfilter="ai"]')).toHaveClass(/active/);
      await expect(othersPrsAuthor.locator('[data-subfilter="ai"] .count')).toHaveText('');

      await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();

      await othersPrsAuthor.locator('[data-subfilter="external"]').click();
      await expect(othersPrsStatus.locator('[data-subfilter="needs-review"]')).toHaveClass(/active/);
      await expect(page.locator('.notification-item')).toHaveCount(0);

      await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(0);
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
    });

    test('switching filters does not trigger review metadata prefetch', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);
      await waitForStatusClear(page);

      await page.locator('#view-others-prs').click();
      const authorFilters = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );
      await authorFilters.locator('[data-subfilter="committer"]').click();
      await expectNoStatusFlash(page, 'Review metadata prefetch');
    });
  });

  test.describe('Subfilter Switching', () => {
    test.beforeEach(async ({ page }) => {
      await openNotificationsWithCachedData(page);
    });

    test('clicking Open subfilter filters to open feed items', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();

      // Check subfilter tab states
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toHaveClass(/active/);

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(1);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('clicking an active subfilter shows all feed items', async ({ page }) => {
      // First switch to open
      const issuesSubfilters = page.locator(
        '.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]'
      );
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Then click again to clear
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);
      await expect(issuesSubfilters.locator('.subfilter-tab.active')).toHaveCount(0);
    });

    test('notification count header updates with subfilter', async ({ page }) => {
      const countHeader = page.locator('#notification-count');

      await expect(countHeader).toHaveText('4 notifications');

      // Open shows 1
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(countHeader).toHaveText('1 notifications');

      await issuesSubfilters.locator('[data-subfilter="closed"]').click();
      await expect(countHeader).toHaveText('3 notifications');
    });

    test('clicking Feed type subfilters switches between PRs and issues', async ({ page }) => {
      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');

      await typeSubfilters.locator('[data-subfilter="prs"]').click();
      await expect(typeSubfilters.locator('[data-subfilter="prs"]')).toHaveClass(/active/);
      await expect(typeSubfilters.locator('[data-subfilter="prs"] .count')).toHaveText('');
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-1"]')).not.toBeAttached();

      await typeSubfilters.locator('[data-subfilter="issues"]').click();
      await expect(typeSubfilters.locator('[data-subfilter="issues"]')).toHaveClass(/active/);
      await expect(page.locator('.notification-item')).toHaveCount(3);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-5"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();
    });

    test('Feed type subfilters compose with Open and Closed', async ({ page }) => {
      const stateSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="state"]');
      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');

      await stateSubfilters.locator('[data-subfilter="open"]').click();
      await typeSubfilters.locator('[data-subfilter="issues"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();

      await typeSubfilters.locator('[data-subfilter="prs"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(0);
      await expect(page.locator('#empty-state')).toBeVisible();
    });
  });

  test.describe('View Persistence', () => {
    test('saves view preference to localStorage', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('ghnotif_view')))
        .toBe('others-prs');
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

      await expect
        .poll(() =>
          page.evaluate(() => {
            const savedViewFilters = localStorage.getItem('ghnotif_view_filters');
            return savedViewFilters ? JSON.parse(savedViewFilters).issues?.state : null;
          })
        )
        .toBe('closed');
    });

    test('saves Feed type subfilter preference to localStorage', async ({ page }) => {
      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');
      await typeSubfilters.locator('[data-subfilter="prs"]').click();

      await expect
        .poll(() =>
          page.evaluate(() => {
            const savedViewFilters = localStorage.getItem('ghnotif_view_filters');
            return savedViewFilters ? JSON.parse(savedViewFilters).issues?.type : null;
          })
        )
        .toBe('prs');
    });

    test('restores subfilter and applies to loaded notifications', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_view', 'issues');
        localStorage.setItem(
          'ghnotif_view_filters',
          JSON.stringify({ issues: { state: 'closed' } })
        );
      });
      await seedNotificationsCache(page, mixedFixture.notifications);

      await page.reload();

      // Check that Closed subfilter is active
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"]')).toHaveClass(/active/);

      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);
    });

    test('restores Feed type subfilter and applies to loaded notifications', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_view', 'issues');
        localStorage.setItem(
          'ghnotif_view_filters',
          JSON.stringify({ issues: { type: 'prs' } })
        );
      });
      await seedNotificationsCache(page, mixedFixture.notifications);

      await page.reload();

      const typeSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"][data-subfilter-group="type"]');
      await expect(typeSubfilters.locator('[data-subfilter="prs"]')).toHaveClass(/active/);
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });

    test('ignores invalid view values in localStorage', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem('ghnotif_view', 'invalid');
      });

      await page.reload();

      // Should default to Feed
      await expect(page.locator('#view-issues')).toHaveClass(/active/);
    });
  });

  test.describe('Empty State with Views', () => {
    test('shows empty state when view has no results', async ({ page }) => {
      await openNotificationsWithCachedData(page);

      await page.locator('#view-pr-notifications').click();

      // Should show empty state
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toBeVisible();
    });

    test('empty state hidden when view has results', async ({ page }) => {
      await openNotificationsWithCachedData(page);

      await expect(page.locator('#empty-state')).not.toBeVisible();

      await page.locator('#view-others-prs').click();
      await expect(page.locator('#empty-state')).not.toBeVisible();
    });
  });

});
