import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';

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

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
  });

  test.describe('Mark Done Button', () => {
    test('Mark Done button is hidden when no items selected', async ({ page }) => {
      const markDoneBtn = page.locator('#mark-done-btn');
      await expect(markDoneBtn).not.toBeVisible();
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
      await expect(page.locator('#mark-done-btn')).not.toBeVisible();
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
        apiCalls.push(route.request().url());
        route.fulfill({
          status: 204,
          contentType: 'application/json',
          body: JSON.stringify({}),
        });
      });

      // Select two items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Marked 2 notifications as done');

      // Verify API was called for both
      expect(apiCalls.length).toBe(2);
      expect(apiCalls.some((url) => url.includes('notif-1'))).toBe(true);
      expect(apiCalls.some((url) => url.includes('notif-2'))).toBe(true);
    });

    test('Mark Done uses DELETE method', async ({ page }) => {
      let requestMethod = '';

      await page.route('**/github/rest/notifications/threads/**', (route) => {
        requestMethod = route.request().method();
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
      expect(requestMethod).toBe('DELETE');
    });
  });

  test.describe('Progress Indicator', () => {
    test('progress bar appears during Mark Done operation', async ({ page }) => {
      // Mock with delay to see progress
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
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
        callCount++;
        await new Promise((r) => setTimeout(r, 100));
        route.fulfill({ status: 204 });
      });

      // Select 3 items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      await page.locator('#mark-done-btn').click();

      // Check progress text appears
      const progressText = page.locator('#progress-text');
      await expect(progressText).toContainText(/Marking \d+ of 3/);

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Marked 3 notifications as done');
    });

    test('progress bar hides after completion', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');

      const progressContainer = page.locator('#progress-container');
      await expect(progressContainer).not.toHaveClass(/visible/);
    });
  });

  test.describe('Removing Marked Notifications', () => {
    test('successfully marked notifications are removed from list', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      // Verify 5 notifications initially
      await expect(page.locator('.notification-item')).toHaveCount(5);

      // Select and mark one
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');

      // Should now have 4 notifications
      await expect(page.locator('.notification-item')).toHaveCount(4);
      await expect(page.locator('[data-id="notif-1"]')).not.toBeAttached();
    });

    test('notification count updates after marking done', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      await expect(page.locator('#count-all')).toHaveText('5');

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 2 notifications as done');
      await expect(page.locator('#count-all')).toHaveText('3');
    });

    test('localStorage is updated after marking done', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');

      const savedNotifications = await page.evaluate(() => {
        const saved = localStorage.getItem('ghnotif_notifications');
        return saved ? JSON.parse(saved) : [];
      });

      expect(savedNotifications.length).toBe(4);
      expect(savedNotifications.find((n: { id: string }) => n.id === 'notif-1')).toBeUndefined();
    });

    test('selection is cleared for marked items', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
      await expect(page.locator('#selection-count')).toHaveText('');
    });
  });

  test.describe('Error Handling', () => {
    test('shows error when API fails', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
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
        callCount++;
        // First call succeeds, second fails
        if (callCount === 1) {
          route.fulfill({ status: 204 });
        } else {
          route.fulfill({ status: 500 });
        }
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('1 done');
      await expect(page.locator('#status-bar')).toContainText('1 failed');
    });

    test('successful items removed even when some fail', async ({ page }) => {
      let callCount = 0;

      await page.route('**/github/rest/notifications/threads/**', (route) => {
        callCount++;
        if (callCount === 1) {
          route.fulfill({ status: 204 });
        } else {
          route.fulfill({ status: 500 });
        }
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('failed');

      // First item should be removed, second should remain
      await expect(page.locator('.notification-item')).toHaveCount(4);
    });
  });

  test.describe('UI State During Operation', () => {
    test('Mark Done button is disabled during operation', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#mark-done-btn')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Marked');
    });

    test('Select All checkbox is disabled during operation', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#select-all-checkbox')).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Marked');
    });

    test('buttons are re-enabled after completion', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Marked');

      // Select another item to show button again
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();

      await expect(page.locator('#mark-done-btn')).toBeEnabled();
      await expect(page.locator('#select-all-checkbox')).toBeEnabled();
    });
  });

  test.describe('Rate Limiting', () => {
    test('handles rate limit response and retries', async ({ page }) => {
      let callCount = 0;

      await page.route('**/github/rest/notifications/threads/**', (route) => {
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
      await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done', {
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

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
  });

  test('extracts thread_id from node ID and uses REST API', async ({ page }) => {
    const apiCalls: string[] = [];

    // Mock REST API endpoint
    await page.route('**/github/rest/notifications/threads/**', async (route) => {
      apiCalls.push(route.request().url());
      route.fulfill({ status: 204 });
    });

    // Select first item (which has a node ID)
    const firstItem = page.locator('.notification-item').first();
    await firstItem.locator('.notification-checkbox').click();

    // Click Mark Done
    await page.locator('#mark-done-btn').click();

    // Should succeed
    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');

    // Should have used REST API with extracted thread_id
    expect(apiCalls.length).toBe(1);
    // The extracted thread_id should be a large number (21474444000)
    expect(apiCalls[0]).toContain('/threads/21474444000');
  });

  test('REST API uses DELETE method for node IDs', async ({ page }) => {
    let requestMethod = '';

    await page.route('**/github/rest/notifications/threads/**', async (route) => {
      requestMethod = route.request().method();
      route.fulfill({ status: 204 });
    });

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
    expect(requestMethod).toBe('DELETE');
  });

  test('handles REST API errors for node IDs gracefully', async ({ page }) => {
    await page.route('**/github/rest/notifications/threads/**', (route) => {
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
      route.fulfill({ status: 204 });
    });

    await expect(page.locator('.notification-item')).toHaveCount(5);

    await page.locator('.notification-item').first().locator('.notification-checkbox').click();
    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Marked 1 notification as done');
    await expect(page.locator('.notification-item')).toHaveCount(4);
  });
});
