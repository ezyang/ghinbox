import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, readNotificationsCache } from './storage-utils';

// Note: syncNotificationBeforeDone now uses HTML pull + ID-based comment comparison
// instead of REST thread timestamp comparison

// Helper to encode a thread_id into a node ID format
// Real GitHub node IDs are base64 encoded and contain "thread_id:user_id"
function encodeNodeId(threadId: number, userId: number = 26517921): string {
  // The format is: binary prefix + "thread_id:user_id"
  // We use a simple prefix that matches GitHub's format
  const data = `\x93\x00\xce\x01\x94\xa1\xa1\xb4${threadId}:${userId}`;
  // Base64 encode (browser-compatible)
  const base64 = Buffer.from(data, 'binary').toString('base64');
  return `NT_${base64}`;
}

// Fixture with realistic GitHub node IDs that contain extractable thread IDs
const fixtureWithNodeIds = {
  ...mixedFixture,
  notifications: mixedFixture.notifications.map((n, i) => ({
    ...n,
    // Use realistic thread IDs that can be extracted (10+ digits)
    id: encodeNodeId(21474444000 + i),
  })),
};

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

    // Mock GraphQL endpoint for prefetch
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { repository: {} } }),
      });
    });

    // Mock REST comment endpoints for prefetch
    await page.route('**/github/rest/repos/**/issues/**/comments**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    await page.route('**/github/rest/repos/**/issues/**', (route) => {
      if (route.request().url().includes('/comments')) {
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
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
    test('clicking Mark Done calls API for each selected notification', async ({ page }) => {
      const apiCalls: string[] = [];

      // Mock the mark done API
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        apiCalls.push(route.request().url());
        route.fulfill({
          status: 204,
          contentType: 'application/json',
          body: JSON.stringify({}),
        });
      });

      // Select two items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');

      // Verify API was called for both
      expect(apiCalls.length).toBe(2);
      expect(apiCalls.some((url) => url.includes('notif-1'))).toBe(true);
      expect(apiCalls.some((url) => url.includes('notif-3'))).toBe(true);
    });

    test('Mark all in Closed subfilter calls API for each closed issue', async ({ page }) => {
      const apiCalls: string[] = [];

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        apiCalls.push(route.request().url());
        route.fulfill({ status: 204 });
      });

      // Switch to Closed subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();
      await page.locator('#mark-done-btn').click();

      // Only 2 closed issues (notif-3 and notif-5), not merged PR
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
      expect(apiCalls.length).toBe(2);
      expect(apiCalls.some((url) => url.includes('notif-3'))).toBe(true);
      expect(apiCalls.some((url) => url.includes('notif-5'))).toBe(true);
    });

    test('Mark Done uses DELETE method', async ({ page }) => {
      let requestMethod = '';

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        requestMethod = route.request().method();
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      expect(requestMethod).toBe('DELETE');
    });
  });

  test.describe('Inline Mark Done', () => {
    test('inline button marks a single notification as done', async ({ page }) => {
      const apiCalls: string[] = [];

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        apiCalls.push(route.request().url());
        route.fulfill({ status: 204 });
      });

      await expect(page.locator('.notification-item')).toHaveCount(3);

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      expect(apiCalls.length).toBe(1);
      expect(apiCalls[0]).toContain('notif-1');
    });

    test('skips marking done when new comments are detected', async ({ page }) => {
      let deleteCalled = false;

      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ updated_at: '2024-12-28T00:00:00Z' }),
          });
          return;
        }
        deleteCalled = true;
        route.fulfill({ status: 204 });
      });
      await page.route(
        '**/github/rest/repos/test/repo/issues/42/comments**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              {
                id: 1,
                user: { login: 'alice' },
                body: 'New comment',
                created_at: '2024-12-28T00:00:00Z',
                updated_at: '2024-12-28T00:00:00Z',
              },
            ]),
          });
        }
      );

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();

      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(1);
      await expect(page.locator('#status-bar')).toContainText('New comments');
      expect(deleteCalled).toBe(false);
    });

    test('reloads notification details when new comments are detected', async ({ page }) => {
      let deleteCalled = false;
      let reloadCalled = false;

      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ updated_at: '2024-12-28T00:00:00Z' }),
          });
          return;
        }
        deleteCalled = true;
        route.fulfill({ status: 204 });
      });
      await page.route(
        '**/github/rest/repos/test/repo/issues/42/comments**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              {
                id: 1,
                user: { login: 'alice' },
                body: 'New comment',
                created_at: '2024-12-28T00:00:00Z',
                updated_at: '2024-12-28T00:00:00Z',
              },
            ]),
          });
        }
      );

      await page.unroute('**/notifications/html/repo/**');
      const updatedFixture = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.map((notification) =>
          notification.id === 'notif-1'
            ? {
                ...notification,
                subject: {
                  ...notification.subject,
                  title: 'Fix critical bug in authentication (updated)',
                },
                updated_at: '2024-12-28T00:00:00Z',
              }
            : notification
        ),
      };
      await page.route('**/notifications/html/repo/**', (route) => {
        reloadCalled = true;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(updatedFixture),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('New comments');
      await expect(page.locator('#status-bar')).toHaveClass(/auto-dismiss/);
      const statusBar = page.locator('#status-bar');
      await statusBar.click();
      await expect(statusBar).toHaveClass(/status-pinned/);
      await statusBar.click();
      await expect(statusBar).toBeHidden({ timeout: 7000 });
      await expect(
        page.locator('[data-id="notif-1"] .notification-title')
      ).toContainText('Fix critical bug in authentication (updated)');
      expect(deleteCalled).toBe(false);
      expect(reloadCalled).toBe(true);
    });

    test('allows marking done when new comments are uninteresting or own', async ({ page }) => {
      let deleteCalled = false;

      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ updated_at: '2024-12-28T00:00:00Z' }),
          });
          return;
        }
        deleteCalled = true;
        route.fulfill({ status: 204 });
      });
      await page.route(
        '**/github/rest/repos/test/repo/issues/42/comments**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              {
                id: 1,
                user: { login: 'testuser' },
                body: 'My own update',
                created_at: '2024-12-28T00:00:00Z',
                updated_at: '2024-12-28T00:00:00Z',
              },
            ]),
          });
        }
      );

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
      expect(deleteCalled).toBe(true);
    });

    test('bottom done button removes the notification from the list', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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

      await page.route('**/github/rest/notifications/threads/**', async (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        await responseGate;
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();

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

      await page.route('**/github/rest/notifications/threads/**', async (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        callCount++;
        if (callCount === 1) {
          await firstGate;
        } else {
          await secondGate;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
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

      await page.route('**/github/rest/notifications/threads/**', async (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        callCount++;
        await new Promise((r) => setTimeout(r, 100));
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('#selection-count')).toHaveText('');
    });
  });

  test.describe('Error Handling', () => {
    test('shows error when API fails', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 500 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Failed to mark notifications');
      await expect(page.locator('#status-bar')).toContainText('500');
      await expect(page.locator('#status-bar')).toHaveClass(/error/);
    });

    test('failed notifications remain in list', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 500 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Failed');

      // Notification should still be in list
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('shows partial success message when some fail', async ({ page }) => {
      let callCount = 0;

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        callCount++;
        // First call succeeds, second fails
        if (callCount === 1) {
          route.fulfill({ status: 204 });
        } else {
          route.fulfill({ status: 500 });
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

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        callCount++;
        if (callCount === 1) {
          route.fulfill({ status: 204 });
        } else {
          route.fulfill({ status: 500 });
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
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#mark-done-btn')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('Select All checkbox is disabled during operation', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#select-all-checkbox')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('buttons are re-enabled after completion', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 204 });
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

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        callCount++;
        if (callCount === 1) {
          // First call: rate limited
          route.fulfill({
            status: 429,
            headers: { 'Retry-After': '1' },
          });
        } else {
          // Retry: success
          route.fulfill({ status: 204 });
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
 * Tests for Mark Done with realistic GitHub node IDs.
 * GitHub's HTML notifications use node IDs (NT_...) which are decoded
 * to extract the thread_id for use with the REST API.
 */
test.describe('Mark Done with Node IDs', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Use fixture with realistic node IDs
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

    // Mock REST comment endpoints for prefetch
    await page.route('**/github/rest/repos/**/issues/**/comments**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    await page.route('**/github/rest/repos/**/issues/**', (route) => {
      if (route.request().url().includes('/comments')) {
        return;
      }
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

  test('extracts thread_id from node ID and uses REST API', async ({ page }) => {
    const apiCalls: string[] = [];

    // Mock REST API endpoint
    await page.route('**/github/rest/notifications/threads/**', async (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(THREAD_SYNC_PAYLOAD),
        });
        return;
      }
      apiCalls.push(route.request().url());
      route.fulfill({ status: 204 });
    });

    // Select first item (which has a node ID)
    const firstItem = page.locator('.notification-item').first();
    await firstItem.locator('.notification-checkbox').click();

    // Click Mark Done
    await page.locator('#mark-done-btn').click();

    // Should succeed
    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');

    // Should have used REST API with extracted thread_id
    expect(apiCalls.length).toBe(1);
    // The extracted thread_id should be a large number (21474444000)
    expect(apiCalls[0]).toContain('/threads/21474444000');
  });

  test('REST API uses DELETE method for node IDs', async ({ page }) => {
    let requestMethod = '';

    await page.route('**/github/rest/notifications/threads/**', async (route) => {

      if (route.request().method() === 'GET') {

        route.fulfill({

          status: 200,

          contentType: 'application/json',

          body: JSON.stringify(THREAD_SYNC_PAYLOAD),

        });

        return;

      }
      requestMethod = route.request().method();
      route.fulfill({ status: 204 });
    });

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
    expect(requestMethod).toBe('DELETE');
  });

  test('handles REST API errors for node IDs gracefully', async ({ page }) => {
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(THREAD_SYNC_PAYLOAD),
        });
        return;
      }
      route.fulfill({ status: 500 });
    });

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Failed to mark notifications');
    await expect(page.locator('#status-bar')).toContainText('500');
    await expect(page.locator('#status-bar')).toHaveClass(/error/);
  });

  test('removes notification after successful REST API mark done with node ID', async ({ page }) => {
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(THREAD_SYNC_PAYLOAD),
        });
        return;
      }
      route.fulfill({ status: 204 });
    });

    await expect(page.locator('.notification-item')).toHaveCount(3);

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
    await expect(page.locator('.notification-item')).toHaveCount(2);
  });
});
