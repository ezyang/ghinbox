import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, seedNotificationsCache } from './storage-utils';

async function waitForStatusClear(page) {
  const statusBar = page.locator('#status-bar');
  await expect(statusBar).toHaveText('', { timeout: 10000 });
}

async function expectNoStatusFlash(page, text, durationMs = 1200, intervalMs = 50) {
  const statusBar = page.locator('#status-bar');
  const end = Date.now() + durationMs;
  let seen = false;
  while (Date.now() < end) {
    const content = (await statusBar.textContent()) || '';
    if (content.includes(text)) {
      seen = true;
      break;
    }
    await page.waitForTimeout(intervalMs);
  }
  expect(seen).toBe(false);
}

/**
 * Filtering Tests
 *
 * Tests for filtering notifications by view (Issues, My PRs, Others' PRs)
 * and by subfilter (All, Open, Closed, Needs Review, Approved, Committers, External).
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

    // Mock GraphQL endpoint for prefetch
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { repository: {} } }),
      });
    });

    // Mock REST comment endpoints for prefetch and syncNotificationBeforeDone
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    // Use broader pattern and filter out comments, to avoid route matching issues
    await page.route('**/github/rest/repos/**/issues/**', (route) => {
      if (route.request().url().includes('/comments')) {
        return; // Let the comments route handle this
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    await page.goto('notifications.html');
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
    await expect(page.locator('.notification-item')).toHaveCount(3);

    await expect.poll(() => graphqlCount, { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => commentCount, { timeout: 5000 }).toBeGreaterThan(0);
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
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toBeVisible();
      await expect(issuesSubfilters.locator('[data-subfilter="closed"]')).toBeVisible();
    });

    test('hides other subfilter tabs when Issues view is active', async ({ page }) => {
      const othersPrsSubfilters = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      await expect(page.locator('.subfilter-tabs[data-for-view="my-prs"]')).toHaveCount(0);
      await expect(othersPrsSubfilters).toHaveClass(/hidden/);
    });

    test('shows Others PRs subfilters when switching to Others PRs view', async ({ page }) => {
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
      await expect(othersPrsStatus.locator('[data-subfilter="draft"]')).toBeVisible();
      await expect(othersPrsStatus.locator('[data-subfilter="closed"]')).toBeVisible();
      await expect(othersPrsAuthor.locator('[data-subfilter="committer"]')).toBeVisible();
      await expect(othersPrsAuthor.locator('[data-subfilter="external"]')).toBeVisible();
    });

    test('subfilter divider stays within the notifications container', async ({ page }) => {
      const container = page.locator('.notifications-container');
      const viewTabs = page.locator('.view-tabs');
      const subfilterTabs = page.locator('.subfilter-tabs[data-for-view="issues"]');

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
      // Sync first
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      // Wait for notifications to load (Issues view shows 3 items from mixed fixture)
      await expect(page.locator('.notification-item')).toHaveCount(3);
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

      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);

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
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });

    test('shows subfilter counts for Issues view', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');

      // 3 issues total: 1 open, 2 closed
      await expect(issuesSubfilters.locator('[data-subfilter="open"] .count')).toHaveText('1');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('2');
    });

    test('hides count on the active subfilter', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');

      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(issuesSubfilters.locator('[data-subfilter="open"] .count')).toHaveText('');
      await expect(issuesSubfilters.locator('[data-subfilter="closed"] .count')).toHaveText('2');
    });

    test('shows subfilter counts for Others PRs view', async ({ page }) => {
      await page.locator('#view-others-prs').click();

      const othersPrsStatus = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      const othersPrsAuthor = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );

      // 2 PRs: 1 open, 1 merged (closed)
      await expect(othersPrsStatus.locator('[data-subfilter="needs-review"] .count')).toHaveText('1');
      await expect(othersPrsStatus.locator('[data-subfilter="approved"] .count')).toHaveText('0');
      await expect(othersPrsStatus.locator('[data-subfilter="draft"] .count')).toHaveText('0');
      await expect(othersPrsStatus.locator('[data-subfilter="closed"] .count')).toHaveText('1');
      await expect(othersPrsAuthor.locator('[data-subfilter="committer"] .count')).toHaveText('0');
      await expect(othersPrsAuthor.locator('[data-subfilter="external"] .count')).toHaveText('0');
    });
  });

  test.describe('Committer Filters', () => {
    test('filters others PRs by committer vs external', async ({ page }) => {
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
                pr43: { reviewDecision: null, authorAssociation: 'COLLABORATOR' },
                pr40: { reviewDecision: null, authorAssociation: 'CONTRIBUTOR' },
              },
            },
          }),
        });
      });

      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);
      await waitForStatusClear(page);
      await page.locator('#view-others-prs').click();

      const othersPrsStatus = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      const othersPrsAuthor = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
      );
      await othersPrsAuthor.locator('[data-subfilter="committer"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-4"]')).not.toBeAttached();

      await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();

      await othersPrsAuthor.locator('[data-subfilter="external"]').click();
      await expect(othersPrsStatus.locator('[data-subfilter="needs-review"]')).toHaveClass(/active/);
      await expect(page.locator('.notification-item')).toHaveCount(0);

      await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });

    test('switching filters does not trigger review metadata prefetch', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(3);
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
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });

    test('clicking Open subfilter filters to open issues', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();

      // Check subfilter tab states
      await expect(issuesSubfilters.locator('[data-subfilter="open"]')).toHaveClass(/active/);

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

    test('clicking an active subfilter shows all issues', async ({ page }) => {
      // First switch to open
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Then click again to clear
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(3);
      await expect(issuesSubfilters.locator('.subfilter-tab.active')).toHaveCount(0);
    });

    test('clicking the active subfilter clears the filter', async ({ page }) => {
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(3);
      await expect(issuesSubfilters.locator('.subfilter-tab.active')).toHaveCount(0);
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
      const parsed = JSON.parse(savedViewFilters!);
      expect(parsed).toHaveProperty('issues');
      expect(parsed.issues).toHaveProperty('state', 'closed');
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
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);

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
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Issues and Others PRs should have results
      await expect(page.locator('#empty-state')).not.toBeVisible();

      await page.locator('#view-others-prs').click();
      await expect(page.locator('#empty-state')).not.toBeVisible();
    });
  });

  test.describe('Filter with Draft PRs', () => {
    test('draft PRs show in the draft subfilter for Others PRs', async ({ page }) => {
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
      // Wait for notifications to load (Issues view shows 3 items)
      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Switch to Others PRs
      await page.locator('#view-others-prs').click();

      // Should show 3 PRs (2 original + 1 draft) in the view count
      await expect(page.locator('#view-others-prs .count')).toHaveText('3');

      const othersPrsSubfilters = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );

      await expect(othersPrsSubfilters.locator('[data-subfilter="draft"] .count')).toHaveText('1');
      await expect(othersPrsSubfilters.locator('[data-subfilter="needs-review"] .count')).toHaveText('1');
      await expect(othersPrsSubfilters.locator('[data-subfilter="approved"] .count')).toHaveText('0');

      // Default subfilter is 'all', so all 3 PRs should be visible
      const items = page.locator('.notification-item');
      await expect(items).toHaveCount(3);

      await othersPrsSubfilters.locator('[data-subfilter="draft"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);
      await expect(page.locator('[data-id="notif-draft"]')).toBeVisible();
    });
  });

  test.describe('Filter with Merged PRs', () => {
    test('merged PRs are included in Closed subfilter for Others PRs', async ({ page }) => {
      const input = page.locator('#repo-input');
      await input.fill('test/repo');
      await page.locator('#sync-btn').click();
      // Wait for notifications to load
      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Switch to Others PRs
      await page.locator('#view-others-prs').click();

      // Switch to Closed subfilter
      const othersPrsSubfilters = page.locator(
        '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
      );
      await othersPrsSubfilters.locator('[data-subfilter="closed"]').click();

      // Merged PR should be visible
      await expect(page.locator('[data-id="notif-4"]')).toBeVisible();
    });
  });
});
