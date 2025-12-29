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

  test.describe('Notification Checkboxes', () => {
    test('checkboxes toggle selection and update count', async ({ page }) => {
      const checkboxes = page.locator('.notification-checkbox');
      await expect(checkboxes).toHaveCount(3);
      await expect(checkboxes.first()).not.toBeChecked();

      const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
      await checkbox.click();

      await expect(checkbox).toBeChecked();
      const item = page.locator('[data-id="notif-1"]');
      await expect(item).toHaveClass(/selected/);

      const count = page.locator('#selection-count');
      await expect(count).toHaveText('1 selected');

      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
      await expect(item).not.toHaveClass(/selected/);
      await expect(count).toHaveText('');
    });
  });

  test.describe('Select All', () => {
    test('select all toggles all notifications and count', async ({ page }) => {
      const selectAll = page.locator('#select-all-checkbox');
      await expect(selectAll).not.toBeChecked();

      await selectAll.click();
      await expect(selectAll).toBeChecked();
      await expect(page.locator('#selection-count')).toHaveText('3 selected');

      await selectAll.click();
      await expect(selectAll).not.toBeChecked();
      await expect(page.locator('#selection-count')).toHaveText('');
    });

    test('select all is indeterminate when some are selected', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      const selectAll = page.locator('#select-all-checkbox');
      const isIndeterminate = await selectAll.evaluate(
        (el: HTMLInputElement) => el.indeterminate
      );
      expect(isIndeterminate).toBe(true);
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
      await expect(page.locator('#selection-count')).toHaveText('3 selected');
    });
  });

  test.describe('Selection with Filters', () => {
    test('select all respects filter and leaves indeterminate state', async ({ page }) => {
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
      const isIndeterminate = await page
        .locator('#select-all-checkbox')
        .evaluate((el: HTMLInputElement) => el.indeterminate);
      expect(isIndeterminate).toBe(true);
    });
  });
});
