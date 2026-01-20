import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, readNotificationsCache } from './storage-utils';

// Note: syncNotificationBeforeDone now uses HTML pull + ID-based comment comparison
// instead of REST thread timestamp comparison

/**
 * Phase 7: Mark Done Tests
 *
 * Tests for marking notifications as done, including progress indicators
 * and error handling.
 */

test.describe('Mark Done', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    // Mock notifications endpoint
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
      });
    });

    // Mock user endpoint for auth check
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
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

    // Mock REST comment endpoints for prefetch and sync
    // Use single * for issue number segment, not ** which matches multiple segments
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    // Use single * for issue number to avoid matching /comments paths
    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    // Default mock for HTML action endpoint (mark done/undo)
    // Individual tests can override this with their own handlers
    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    // Wait for notifications to load
    await expect(page.locator('.notification-item')).toHaveCount(3);
  });

  test.describe('Mark Done Button', () => {
    test('Mark Done button is visible when no items selected in All tab', async ({ page }) => {
      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).toBeVisible();
      await expect(markDoneBtn).toHaveText('Mark all as done');
    });

    test('Mark all button appears in Closed subfilter when nothing is selected', async ({ page }) => {
      // Switch to Closed subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).toBeVisible();
      await expect(markDoneBtn).toHaveText('Mark all as done');
    });

    test('Mark all button switches to Mark selected in Closed subfilter', async ({ page }) => {
      // Switch to Closed subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).toHaveText('Mark all as done');

      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await expect(markDoneBtn).toHaveText('Mark selected as done');
    });

    test('Mark Done button appears when items are selected', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).toBeVisible();
    });

    test('Mark Done button disappears when selection is cleared', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await expect(page.locator('#mark-done-btn')).toBeVisible();

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await expect(page.locator('#mark-done-btn')).toBeVisible();
      await expect(page.locator('#mark-done-btn')).toHaveText('Mark all as done');
    });

    test('Mark Done button has danger styling', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).toHaveClass(/btn-danger/);
    });
  });

  test.describe('Mark Done API Calls', () => {
    test('clicking Mark Done calls HTML action API for each selected notification', async ({ page }) => {
      const apiCalls: { action: string; notification_ids: string[] }[] = [];

      // Override the default mock with custom tracking
      await page.unroute('**/notifications/html/action');
      await page.route('**/notifications/html/action', async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}');
          apiCalls.push({ action: body.action, notification_ids: body.notification_ids });
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok' }),
          });
        } else {
          route.continue();
        }
      });

      // Select two items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');

      // Verify API was called for both (one call per notification)
      expect(apiCalls.length).toBe(2);
      expect(apiCalls.every((c) => c.action === 'archive')).toBe(true);
      expect(apiCalls.some((c) => c.notification_ids.includes('notif-1'))).toBe(true);
      expect(apiCalls.some((c) => c.notification_ids.includes('notif-3'))).toBe(true);
    });

    test('Mark all in Closed subfilter calls API for each closed issue', async ({ page }) => {
      const apiCalls: { notification_ids: string[] }[] = [];

      await page.route('**/notifications/html/action', async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}');
          apiCalls.push({ notification_ids: body.notification_ids });
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok' }),
          });
        } else {
          route.continue();
        }
      });

      // Switch to Closed subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();
      await page.locator('#mark-done-btn').click();

      // Only 2 closed issues (notif-3 and notif-5), not merged PR
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
      expect(apiCalls.length).toBe(2);
      expect(apiCalls.some((c) => c.notification_ids.includes('notif-3'))).toBe(true);
      expect(apiCalls.some((c) => c.notification_ids.includes('notif-5'))).toBe(true);
    });

    test('Mark Done uses POST method to HTML action endpoint', async ({ page }) => {
      let requestMethod = '';

      await page.route('**/notifications/html/action', async (route) => {
        requestMethod = route.request().method();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      expect(requestMethod).toBe('POST');
    });
  });

  test.describe('Inline Mark Done', () => {
    test('inline button marks a single notification as done', async ({ page }) => {
      const apiCalls: string[] = [];

      // Ensure comments endpoint returns empty array (no new comments)
      await page.unroute('**/github/rest/repos/**/issues/*/comments');
      await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      });

      await page.route('**/notifications/html/action', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        apiCalls.push(body.notification_ids[0]);
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await expect(page.locator('.notification-item')).toHaveCount(3);

      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      expect(apiCalls.length).toBe(1);
      expect(apiCalls[0]).toBe('notif-1');
    });

    test('skips archive when new comments are detected but removes from UI', async ({ page }) => {
      let archiveCalled = false;

      // Mock HTML action (should not be called)
      await page.route('**/notifications/html/action', (route) => {
        archiveCalled = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Mock comments endpoint to return a new comment from another user
      // Since cache is empty, all comments returned are considered "new"
      await page.unroute('**/github/rest/repos/**/issues/*/comments');
      await page.route(
        '**/github/rest/repos/test/repo/issues/42/comments**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              {
                id: 999, // New comment ID not in cache
                user: { login: 'alice' },
                body: 'New comment',
                created_at: '2024-12-28T00:00:00Z',
                updated_at: '2024-12-28T00:00:00Z',
              },
            ]),
          });
        }
      );

      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();

      // Notification is removed from UI immediately (optimistic update)
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      // Status shows that new comments were detected
      await expect(page.locator('#status-bar')).toContainText('New comments detected');
      // Archive should NOT have been called
      expect(archiveCalled).toBe(false);
    });

    test('allows marking done when new comments are uninteresting or own', async ({ page }) => {
      let archiveCalled = false;

      await page.route('**/notifications/html/action', (route) => {
        archiveCalled = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Mock comments endpoint to return a comment from the current user (testuser)
      // Since it's the user's own comment, it should allow marking done
      await page.unroute('**/github/rest/repos/**/issues/*/comments');
      await page.route(
        '**/github/rest/repos/test/repo/issues/42/comments**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              {
                id: 999,
                user: { login: 'testuser' },
                body: 'My own update',
                created_at: '2024-12-28T00:00:00Z',
                updated_at: '2024-12-28T00:00:00Z',
              },
            ]),
          });
        }
      );

      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      expect(archiveCalled).toBe(true);
    });

    test('allows marking done when notification is already Done on GitHub', async ({ page }) => {
      let archiveCalled = false;

      await page.route('**/notifications/html/action', (route) => {
        archiveCalled = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // HTML endpoint returns fixture WITHOUT notif-1 (it's been marked Done on GitHub)
      await page.unroute('**/notifications/html/repo/**');
      const fixtureWithoutNotif1 = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.filter((n) => n.id !== 'notif-1'),
      };
      await page.route('**/notifications/html/repo/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(fixtureWithoutNotif1),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      expect(archiveCalled).toBe(true);
    });

    test('bottom done button removes the notification from the list', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('#comment-expand-issues-toggle').check();
      await page.locator('#comment-expand-prs-toggle').check();

      await expect(page.locator('.notification-done-btn-bottom').first()).toBeVisible();

      await page.locator('[data-id="notif-1"] .notification-done-btn-bottom').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
    });

    test('removes notification before the Mark Done request completes', async ({ page }) => {
      let releaseResponse: (() => void) | null = null;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });

      await page.route('**/notifications/html/action', async (route) => {
        await responseGate;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();

      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      await expect(page.locator('.notification-item')).toHaveCount(2);

      if (!releaseResponse) {
        throw new Error('Expected releaseResponse to be assigned');
      }
      releaseResponse();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
    });
  });

  test.describe('Progress Indicator', () => {
    test('status bar snapshots pending and done counts during async requests', async ({ page }) => {
      let callCount = 0;
      let releaseFirst: (() => void) | null = null;
      let releaseSecond: (() => void) | null = null;

      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      await page.route('**/notifications/html/action', async (route) => {
        callCount++;
        if (callCount === 1) {
          await firstGate;
        } else {
          await secondGate;
        }
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 0/1 (1 pending)');

      if (!releaseFirst || !releaseSecond) {
        throw new Error('Expected gate release functions to be assigned');
      }
      releaseFirst();

      await expect(page.locator('#status-bar')).toContainText('Done 1/2 (1 pending)');

      releaseSecond();

      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
    });

    test('done status can be dismissed and auto-dismisses after completion', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const statusBar = page.locator('#status-bar');

      const notificationCheckboxes = page.locator('.notification-item .notification-checkbox');

      await notificationCheckboxes.first().click();
      await page.locator('#mark-done-btn').click();

      await expect(statusBar).toContainText('Done');
      await expect(statusBar).toContainText('(0 pending)');
      await expect(statusBar).toHaveClass(/auto-dismiss/);
      await statusBar.click();
      await expect(statusBar).not.toHaveClass(/auto-dismiss/);
      await expect(statusBar).toHaveClass(/status-pinned/);
      await statusBar.click();
      await expect(statusBar).toBeHidden();

      await expect(page.locator('.notification-item')).toHaveCount(2);
      await notificationCheckboxes.first().click();
      await page.locator('#mark-done-btn').click();

      await expect(statusBar).toContainText('Done');
      await expect(statusBar).toContainText('(0 pending)');
      await expect(statusBar).toHaveClass(/auto-dismiss/);
      await expect(statusBar).toBeHidden({ timeout: 7000 });
    });

    test('progress bar appears during Mark Done operation', async ({ page }) => {
      // Mock with delay to see progress
      await page.route('**/notifications/html/action', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Select multiple items
      await page.locator('#select-all-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Progress container should be visible
      const progressContainer = page.locator('#progress-container');
      await expect(progressContainer).toHaveClass(/visible/);
    });

    test('progress text shows current progress', async ({ page }) => {
      let callCount = 0;

      await page.route('**/notifications/html/action', async (route) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 100));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Select 3 items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await page.locator('[data-id="notif-5"] .notification-checkbox').click();

      await page.locator('#mark-done-btn').click();

      // Check progress text appears
      const progressText = page.locator('#progress-text');
      await expect(progressText).toContainText(/Marking \d+ of 3/);

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done 3/3 (0 pending)');
    });

    test('progress bar hides after completion', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');

      const progressContainer = page.locator('#progress-container');
      await expect(progressContainer).not.toHaveClass(/visible/);
    });
  });

  test.describe('Removing Marked Notifications', () => {
    test('successfully marked notifications are removed from the list', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Verify 3 notifications initially
      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Select and mark one
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');

      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
    });

    test('notification count updates after marking done', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const countClosed = page.locator(
        '.subfilter-tabs[data-for-view="issues"] [data-subfilter="closed"] .count'
      );
      await expect(countClosed).toHaveText('2');

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
      await expect(countClosed).toHaveText('1');
    });

    test('IndexedDB is updated after marking done', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');

      const savedNotifications = await readNotificationsCache(page);
      const savedList = savedNotifications as { id: string }[];
      expect(savedList.length).toBe(4);
      expect(savedList.find((n) => n.id === 'notif-1')).toBeUndefined();
    });

    test('selection is cleared for marked items', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('#selection-count')).toHaveText('');
    });
  });

  test.describe('Error Handling', () => {
    test('shows error when API fails', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', error: 'Server error' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Failed to mark notifications');
      await expect(page.locator('#status-bar')).toContainText('Server error');
      await expect(page.locator('#status-bar')).toHaveClass(/error/);
    });

    test('failed notifications remain in list', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', error: 'Failed' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Failed');

      // Notification should still be in list
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('shows partial success message when some fail', async ({ page }) => {
      let callCount = 0;

      await page.route('**/notifications/html/action', (route) => {
        callCount++;
        // First call succeeds, second fails
        if (callCount === 1) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok' }),
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'error', error: 'Failed' }),
          });
        }
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('1 done');
      await expect(page.locator('#status-bar')).toContainText('1 failed');
    });

    test('successful items are removed even when some fail', async ({ page }) => {
      let callCount = 0;

      await page.route('**/notifications/html/action', (route) => {
        callCount++;
        if (callCount === 1) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok' }),
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'error', error: 'Failed' }),
          });
        }
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('failed');

      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      await expect(page.locator('[data-id="notif-3"]')).toHaveCount(1);
    });
  });

  test.describe('UI State During Operation', () => {
    test('Mark Done button is disabled during operation', async ({ page }) => {
      await page.route('**/notifications/html/action', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#mark-done-btn')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('Select All checkbox is disabled during operation', async ({ page }) => {
      await page.route('**/notifications/html/action', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#select-all-checkbox')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('buttons are re-enabled after completion', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done');

      // Select another item to show button again
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      await expect(page.locator('#mark-done-btn')).toBeEnabled();
      await expect(page.locator('#select-all-checkbox')).toBeEnabled();
    });
  });

  test.describe('Rate Limiting', () => {
    test('handles rate limit response and retries', async ({ page }) => {
      let callCount = 0;

      await page.route('**/notifications/html/action', (route) => {
        callCount++;
        if (callCount === 1) {
          // First call: rate limited
          route.fulfill({
            status: 429,
            headers: { 'Retry-After': '1' },
          });
        } else {
          // Retry: success
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok' }),
          });
        }
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      // Should show rate limit message briefly
      await expect(page.locator('#status-bar')).toContainText('Rate limited');

      // Should eventually succeed
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)', {
        timeout: 5000,
      });

      // Should have made 2 calls (initial + retry)
      expect(callCount).toBe(2);
    });
  });
});

/**
 * Tests for Mark Done with node IDs.
 * GitHub's HTML notifications use node IDs (NT_...) which are now
 * used directly with the HTML action endpoint.
 */
test.describe('Mark Done with Node IDs', () => {
  // Fixture with node IDs (using simple node IDs for testing)
  const fixtureWithNodeIds = {
    ...mixedFixture,
    notifications: mixedFixture.notifications.map((n, i) => ({
      ...n,
      id: `NT_testNodeId${i}`,
    })),
  };

  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Use fixture with node IDs
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixtureWithNodeIds),
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

    // Mock REST comment endpoints for prefetch and sync
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    // Wait for notifications to load
    await expect(page.locator('.notification-item')).toHaveCount(3);
  });

  test('uses node ID directly with HTML action endpoint', async ({ page }) => {
    const apiCalls: { notification_ids: string[] }[] = [];

    // Mock HTML action endpoint
    await page.route('**/notifications/html/action', (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      apiCalls.push({ notification_ids: body.notification_ids });
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    // Select first item (which has a node ID)
    const firstItem = page.locator('.notification-item').first();
    await firstItem.locator('.notification-checkbox').click();

    // Click Mark Done
    await page.locator('#mark-done-btn').click();

    // Should succeed
    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');

    // Should have used HTML action endpoint with the node ID directly
    expect(apiCalls.length).toBe(1);
    expect(apiCalls[0].notification_ids[0]).toBe('NT_testNodeId0');
  });

  test('HTML action uses POST method for node IDs', async ({ page }) => {
    let requestMethod = '';

    await page.route('**/notifications/html/action', (route) => {
      requestMethod = route.request().method();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
    expect(requestMethod).toBe('POST');
  });

  test('handles HTML action errors for node IDs gracefully', async ({ page }) => {
    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', error: 'Server error' }),
      });
    });

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Failed to mark notifications');
    await expect(page.locator('#status-bar')).toContainText('Server error');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('removes notification after successful HTML action mark done with node ID', async ({ page }) => {
    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await expect(page.locator('.notification-item')).toHaveCount(3);

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
    await expect(page.locator('.notification-item')).toHaveCount(2);
  });
});
