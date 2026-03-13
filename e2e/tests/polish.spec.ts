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


  test.describe('Checkboxes During Mark Done', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('checkboxes remain enabled during Mark Done operation', async ({ page }) => {
      await page.route('**/notifications/html/action', async (route) => {
        await new Promise((r) => setTimeout(r, 300));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Select one item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Click Mark Done
      await page.locator('#mark-done-btn').click();

      // Checkboxes and select-all should remain enabled so users can queue more
      await expect(page.locator('#select-all-checkbox')).toBeEnabled();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText(/Marked as done|Done/);
    });
  });
});
