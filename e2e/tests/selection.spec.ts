import { test, expect } from '@playwright/test';
import {
  expectSelectionCount,
  openNotificationsWithCachedData,
  selectNotification,
  subfilterTab,
  testIds,
} from './app-fixture';

/**
 * Phase 6: Selection Tests
 *
 * Tests for notification selection including checkboxes, select all,
 * and shift-click range selection.
 */

test.describe('Selection', () => {
  test.beforeEach(async ({ page }) => {
    await openNotificationsWithCachedData(page);
  });

  test.describe('Notification Checkboxes', () => {
    test('checkboxes toggle selection and update count @smoke', async ({ page }) => {
      const checkboxes = page.locator('.notification-checkbox');
      await expect(checkboxes).toHaveCount(4);
      await expect(checkboxes.first()).not.toBeChecked();

      const checkbox = page.locator(testIds.notificationCheckbox('notif-1'));
      await selectNotification(page, 'notif-1');

      await expect(checkbox).toBeChecked();
      const item = page.locator(testIds.notification('notif-1'));
      await expect(item).toHaveClass(/selected/);

      await expectSelectionCount(page, '1 selected');

      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
      await expect(item).not.toHaveClass(/selected/);
      await expectSelectionCount(page, '');
    });
  });

  test.describe('Select All', () => {
    test('select all toggles all notifications and count', async ({ page }) => {
      const selectAll = page.locator('#select-all-checkbox');
      await expect(selectAll).not.toBeChecked();

      await selectAll.click();
      await expect(selectAll).toBeChecked();
      await expectSelectionCount(page, '4 selected');

      await selectAll.click();
      await expect(selectAll).not.toBeChecked();
      await expectSelectionCount(page, '');
    });

    test('select all is indeterminate when some are selected', async ({ page }) => {
      await selectNotification(page, 'notif-1');
      const selectAll = page.locator('#select-all-checkbox');
      await expect(selectAll).toHaveJSProperty('indeterminate', true);
    });
  });

  test.describe('Shift-Click Range Selection', () => {
    test('shift-click selects range of notifications', async ({ page }) => {
      // Click first item
      await selectNotification(page, 'notif-1');

      // Shift-click last item
      await selectNotification(page, 'notif-5', { shift: true });

      // Items 1, 3, 4, and 5 should be selected
      await expect(page.locator(testIds.notification('notif-1'))).toHaveClass(/selected/);
      await expect(page.locator(testIds.notification('notif-3'))).toHaveClass(/selected/);
      await expect(page.locator(testIds.notification('notif-4'))).toHaveClass(/selected/);
      await expect(page.locator(testIds.notification('notif-5'))).toHaveClass(/selected/);
      await expectSelectionCount(page, '4 selected');
    });
  });

  test.describe('Selection with Filters', () => {
    test('select all respects filter and leaves indeterminate state', async ({ page }) => {
      // Switch to Open subfilter (Issues view is default)
      await subfilterTab(page, 'issues', 'open').click();
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Select all (in Open filter)
      await page.locator('#select-all-checkbox').click();

      // Count should be 1 (only 1 open issue)
      await expectSelectionCount(page, '1 selected');

      // Clear the filter
      await subfilterTab(page, 'issues', 'open').click();

      // Only 1 should be selected (the open one)
      const selectedItems = page.locator('.notification-item.selected');
      await expect(selectedItems).toHaveCount(1);
      await expect(page.locator('#select-all-checkbox')).toHaveJSProperty('indeterminate', true);
    });
  });
});
