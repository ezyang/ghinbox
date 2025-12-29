import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

/**
 * Phase 6: Selection Tests
 *
 * Tests for notification selection including checkboxes, select all,
 * and shift-click range selection.
 */

test.describe('Selection', () => {
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
    await clearAppStorage(page);

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
  });

  test.describe('Notification Checkboxes', () => {
    test('each notification has a checkbox', async ({ page }) => {
      const checkboxes = page.locator('.notification-checkbox');
      await expect(checkboxes).toHaveCount(3);
    });

    test('checkboxes are unchecked by default', async ({ page }) => {
      const checkboxes = page.locator('.notification-checkbox');
      const count = await checkboxes.count();

      for (let i = 0; i < count; i++) {
        await expect(checkboxes.nth(i)).not.toBeChecked();
      }
    });

    test('clicking checkbox selects notification', async ({ page }) => {
      const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
      await checkbox.click();

      await expect(checkbox).toBeChecked();
    });

    test('selected notification has selected class', async ({ page }) => {
      const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
      await checkbox.click();

      const item = page.locator('[data-id="notif-1"]');
      await expect(item).toHaveClass(/selected/);
    });

    test('clicking checkbox again deselects notification', async ({ page }) => {
      const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
      await checkbox.click();
      await checkbox.click();

      await expect(checkbox).not.toBeChecked();
      await expect(page.locator('[data-id="notif-1"]')).not.toHaveClass(/selected/);
    });

    test('can select multiple notifications', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();

      await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-5"]')).not.toHaveClass(/selected/);
    });

    test('checkbox has aria-label for accessibility', async ({ page }) => {
      const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
      await expect(checkbox).toHaveAttribute('aria-label', /Select notification:/);
    });
  });

  test.describe('Select All', () => {
    test('select all row is visible when notifications exist', async ({ page }) => {
      const selectAllRow = page.locator('#select-all-row');
      await expect(selectAllRow).toBeVisible();
    });

    test('select all row is hidden before sync', async ({ page }) => {
      // Clear and reload
      await clearAppStorage(page);
      await page.reload();

      const selectAllRow = page.locator('#select-all-row');
      await expect(selectAllRow).not.toBeVisible();
    });

    test('select all checkbox is unchecked by default', async ({ page }) => {
      const selectAll = page.locator('#select-all-checkbox');
      await expect(selectAll).not.toBeChecked();
    });

    test('clicking select all selects all notifications', async ({ page }) => {
      await page.locator('#select-all-checkbox').click();

      const checkboxes = page.locator('.notification-checkbox');
      const count = await checkboxes.count();

      for (let i = 0; i < count; i++) {
        await expect(checkboxes.nth(i)).toBeChecked();
      }
    });

    test('clicking select all again deselects all', async ({ page }) => {
      await page.locator('#select-all-checkbox').click();
      await page.locator('#select-all-checkbox').click();

      const checkboxes = page.locator('.notification-checkbox');
      const count = await checkboxes.count();

      for (let i = 0; i < count; i++) {
        await expect(checkboxes.nth(i)).not.toBeChecked();
      }
    });

    test('select all checkbox becomes checked when all are selected', async ({ page }) => {
      // Select all manually
      const checkboxes = page.locator('.notification-checkbox');
      const count = await checkboxes.count();

      for (let i = 0; i < count; i++) {
        await checkboxes.nth(i).click();
      }

      await expect(page.locator('#select-all-checkbox')).toBeChecked();
    });

    test('select all checkbox is indeterminate when some are selected', async ({ page }) => {
      // Select just one
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      const selectAll = page.locator('#select-all-checkbox');
      const isIndeterminate = await selectAll.evaluate(
        (el: HTMLInputElement) => el.indeterminate
      );
      expect(isIndeterminate).toBe(true);
    });

    test('select all has aria-label', async ({ page }) => {
      const selectAll = page.locator('#select-all-checkbox');
      await expect(selectAll).toHaveAttribute('aria-label', 'Select all notifications');
    });
  });

  test.describe('Selection Count', () => {
    test('selection count is hidden when none selected', async ({ page }) => {
      const count = page.locator('#selection-count');
      await expect(count).toHaveText('');
    });

    test('selection count shows number of selected items', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      const count = page.locator('#selection-count');
      await expect(count).toHaveText('1 selected');
    });

    test('selection count updates when more items selected', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-3"] .notification-checkbox').click();
      await page.locator('[data-id="notif-5"] .notification-checkbox').click();

      const count = page.locator('#selection-count');
      await expect(count).toHaveText('3 selected');
    });

    test('selection count has highlight style when items selected', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      const count = page.locator('#selection-count');
      await expect(count).toHaveClass(/has-selection/);
    });

    test('selection count updates after select all', async ({ page }) => {
      await page.locator('#select-all-checkbox').click();

      const count = page.locator('#selection-count');
      await expect(count).toHaveText('3 selected');
    });
  });

  test.describe('Shift-Click Range Selection', () => {
    test('shift-click selects range of notifications', async ({ page }) => {
      // Click first item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Shift-click last item
      await page.locator('[data-id="notif-5"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      // Items 1, 3, 5 should be selected
      await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-5"]')).toHaveClass(/selected/);
    });

    test('shift-click works in reverse order', async ({ page }) => {
      // Click last item
      await page.locator('[data-id="notif-5"] .notification-checkbox').click();

      // Shift-click first item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      // Items 1, 3, 5 should be selected
      await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-5"]')).toHaveClass(/selected/);
    });

    test('shift-click can bulk unselect a range', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-5"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      await page.locator('[data-id="notif-3"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-3"]')).not.toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-5"]')).not.toHaveClass(/selected/);
    });

    test('shift-click without previous selection works as regular click', async ({ page }) => {
      // Shift-click without any previous selection
      await page.locator('[data-id="notif-3"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      // Only item 3 should be selected
      await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-1"]')).not.toHaveClass(/selected/);
      await expect(page.locator('[data-id="notif-5"]')).not.toHaveClass(/selected/);
    });

    test('selection count updates correctly after shift-click', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-5"] .notification-checkbox').click({
        modifiers: ['Shift'],
      });

      const count = page.locator('#selection-count');
      await expect(count).toHaveText('3 selected');
    });
  });

  test.describe('Selection with Filters', () => {
    test('select all only selects filtered notifications', async ({ page }) => {
      // Switch to Open subfilter (Issues view is default)
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Select all (in Open filter)
      await page.locator('#select-all-checkbox').click();

      // Count should be 1 (only 1 open issue)
      await expect(page.locator('#selection-count')).toHaveText('1 selected');

      // Clear the filter
      await issuesSubfilters.locator('[data-subfilter="open"]').click();

      // Only 1 should be selected (the open one)
      const selectedItems = page.locator('.notification-item.selected');
      await expect(selectedItems).toHaveCount(1);
    });

    test('selection persists when switching filters', async ({ page }) => {
      // Select an item
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();

      // Switch to Closed subfilter
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      // Clear the filter
      await issuesSubfilters.locator('[data-subfilter="closed"]').click();

      // Item should still be selected
      await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/selected/);
    });

    test('select all checkbox reflects filtered selection state', async ({ page }) => {
      // Select all open notifications
      const issuesSubfilters = page.locator('.subfilter-tabs[data-for-view="issues"]');
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      await page.locator('#select-all-checkbox').click();

      // Select all should be checked
      await expect(page.locator('#select-all-checkbox')).toBeChecked();

      // Clear the filter - select all should be indeterminate
      await issuesSubfilters.locator('[data-subfilter="open"]').click();
      const isIndeterminate = await page
        .locator('#select-all-checkbox')
        .evaluate((el: HTMLInputElement) => el.indeterminate);
      expect(isIndeterminate).toBe(true);
    });
  });

  test.describe('Selection Visual Styling', () => {
    test('selected items have blue background', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      // Move mouse away to avoid hover state
      await page.mouse.move(0, 0);

      const item = page.locator('[data-id="notif-1"]');
      await expect(item).toHaveCSS('background-color', 'rgb(221, 244, 255)');
    });

    test('unselected items do not have selected background', async ({ page }) => {
      const item = page.locator('[data-id="notif-1"]');
      await expect(item).not.toHaveClass(/selected/);
    });
  });
});
