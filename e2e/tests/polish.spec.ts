import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

const THREAD_SYNC_PAYLOAD = {
  updated_at: '2000-01-01T00:00:00Z',
  last_read_at: null,
  unread: true,
};

/**
 * Phase 8: Polish Tests
 *
 * Tests for keyboard shortcuts, improved empty states, confirmation dialogs,
 * and other polish items.
 */

test.describe('Polish', () => {
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

    // Mock comments endpoint for syncNotificationBeforeDone
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test.describe('Keyboard Shortcuts', () => {
    test.beforeEach(async ({ page }) => {
      // Sync to load notifications
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('Escape key clears selection', async ({ page }) => {
      // Select some items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      await expect(page.locator('#selection-count')).toHaveText('2 selected');

      // Press Escape
      await page.keyboard.press('Escape');

      // Selection should be cleared
      await expect(page.locator('#selection-count')).toHaveText('');
      await expect(page.locator('[data-id="notif-1"]')).not.toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-3"]')).not.toHaveClass(/selected/);
    });

    test('Escape does nothing when no selection', async ({ page }) => {
      // Press Escape with no selection
      await page.keyboard.press('Escape');

      // No errors, page still works
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });

    test('Ctrl+A selects all notifications', async ({ page }) => {
      // Press Ctrl+A
      await page.keyboard.press('Control+a');

      // All items should be selected
      await expect(page.locator('#selection-count')).toHaveText('3 selected');
      await expect(page.locator('#select-all-checkbox')).toBeChecked();
    });

    test('Cmd+A selects all notifications on Mac', async ({ page }) => {
      // Press Cmd+A (Meta+A)
      await page.keyboard.press('Meta+a');

      // All items should be selected
      await expect(page.locator('#selection-count')).toHaveText('3 selected');
    });

    test('keyboard shortcuts do not work in input field', async ({ page }) => {
      // Focus the input field
      await page.locator('#repo-input').focus();

      // Select some items first
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Focus back to input
      await page.locator('#repo-input').focus();

      // Press Escape
      await page.keyboard.press('Escape');

      // Selection should NOT be cleared (because we're in an input)
      await expect(page.locator('#selection-count')).toHaveText('1 selected');
    });
  });

  test.describe('Empty State Messages', () => {
    test('shows default empty state before sync', async ({ page }) => {
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toContainText('No notifications');
      await expect(emptyState).toContainText('Enter a repository and click Quick Sync');
    });

    test('shows "no open" message when filtered to Open with none', async ({ page }) => {
      // Create fixture with only closed notifications
      const onlyClosedFixture = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.filter(
          (n) => n.subject.state === 'closed' || n.subject.state === 'merged'
        ),
      };

      await page.route(
        '**/notifications/html/repo/**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(onlyClosedFixture),
          });
        },
        { times: 1 }
      );

      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to Open subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();

      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toContainText('No open issue notifications');
      await expect(emptyState).toContainText('closed or merged');
    });

    test('shows "no closed" message when filtered to Closed with none', async ({ page }) => {
      // Create fixture with only open issues
      const onlyOpenFixture = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.filter(
          (n) => n.subject.state === 'open' && n.subject.type === 'Issue'
        ),
      };

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

      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced');

      // Switch to Closed subfilter in Issues view
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toContainText('No closed issue notifications');
      await expect(emptyState).toContainText('still open');
    });
  });

  test.describe('Confirmation Dialog', () => {
    test.beforeEach(async ({ page }) => {
      // Sync to load notifications
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('no confirmation for small number of items', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 205 });
      });

      // Select just a few items
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      // Click Mark Done - should proceed without confirmation
      await page.locator('#mark-done-btn').click();

      // Should complete without dialog
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
    });

    test('confirmation appears for 10+ items', async ({ page }) => {
      // Create fixture with 15 notifications
      const largeFixture = {
        ...mixedFixture,
        notifications: Array.from({ length: 15 }, (_, i) => ({
          ...mixedFixture.notifications[0],
          id: `notif-${i + 1}`,
        })),
      };

      await page.route(
        '**/notifications/html/repo/**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(largeFixture),
          });
        },
        { times: 1 }
      );

      // Re-sync to get more notifications
      await page.locator('#full-sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 15 notifications');

      await page.route('**/github/rest/notifications/threads/**', (route) => {

        if (route.request().method() === 'GET') {

          route.fulfill({

            status: 200,

            contentType: 'application/json',

            body: JSON.stringify(THREAD_SYNC_PAYLOAD),

          });

          return;

        }
        route.fulfill({ status: 205 });
      });

      // Set up dialog handler to accept
      page.on('dialog', (dialog) => {
        expect(dialog.message()).toContain('15 notifications');
        dialog.accept();
      });

      // Select all items
      await page.locator('#select-all-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Should complete after accepting dialog
      await expect(page.locator('#status-bar')).toContainText('Done 15/15 (0 pending)');
    });

    test('cancelling confirmation prevents Mark Done', async ({ page }) => {
      // Create fixture with 10 notifications
      const largeFixture = {
        ...mixedFixture,
        notifications: Array.from({ length: 10 }, (_, i) => ({
          ...mixedFixture.notifications[0],
          id: `notif-${i + 1}`,
        })),
      };

      await page.route(
        '**/notifications/html/repo/**',
        (route) => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(largeFixture),
          });
        },
        { times: 1 }
      );

      // Re-sync
      await page.locator('#full-sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 10 notifications');

      // Set up dialog handler to dismiss
      page.on('dialog', (dialog) => {
        dialog.dismiss();
      });

      // Select all items
      await page.locator('#select-all-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Status bar should still show sync message (not marked)
      await expect(page.locator('#status-bar')).toContainText('Synced 10 notifications');

      // All items should still be there
      await expect(page.locator('.notification-item')).toHaveCount(10);
    });
  });

  test.describe('Checkboxes During Mark Done', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('checkboxes are disabled during Mark Done operation', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', async (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
        route.fulfill({ status: 205 });
      });

      // Select one item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // All checkboxes should be disabled
      await expect
        .poll(async () => {
          return await page
            .locator('.notification-checkbox')
            .evaluateAll((elements) => {
              return elements.length > 0 && elements.every((el) => el.disabled);
            });
        })
        .toBe(true);

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('checkboxes are re-enabled after Mark Done completes', async ({ page }) => {
      await page.route('**/github/rest/notifications/threads/**', (route) => {
        if (route.request().method() === 'GET') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(THREAD_SYNC_PAYLOAD),
          });
          return;
        }
        route.fulfill({ status: 205 });
      });

      // Select one item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done');

      // Remaining checkboxes should be enabled
      const checkboxes = page.locator('.notification-item .notification-checkbox');
      await expect(checkboxes).toHaveCount(2);
      await expect
        .poll(async () => {
          const enabledStates = await checkboxes.evaluateAll((nodes) =>
            nodes.map((node) => !node.disabled)
          );
          return enabledStates.every(Boolean);
        })
        .toBe(true);
    });
  });
});
