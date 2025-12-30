import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';
import mixedFixture from '../fixtures/notifications_mixed.json';

const THREAD_SYNC_PAYLOAD = {
  updated_at: '2000-01-01T00:00:00Z',
  last_read_at: null,
  unread: true,
};

async function waitForScrollSettled(
  page,
  { timeoutMs = 1000, intervalMs = 50, settleMs = 200 } = {}
) {
  let last = await page.evaluate(() => window.scrollY);
  let stableFor = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(intervalMs);
    const current = await page.evaluate(() => window.scrollY);

    if (Math.abs(current - last) < 1) {
      stableFor += intervalMs;
      if (stableFor >= settleMs) {
        return current;
      }
    } else {
      stableFor = 0;
      last = current;
    }
  }

  return page.evaluate(() => window.scrollY);
}

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

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

    const commentCache = {
      version: 1,
      threads: {
        'notif-2': {
          notificationUpdatedAt: mixedFixture.notifications[1].updated_at,
          lastReadAt: mixedFixture.notifications[1].last_read_at || null,
          unread: true,
          allComments: true,
          fetchedAt: new Date().toISOString(),
          comments: [],
          reviews: [
            {
              user: { login: 'reviewer' },
              state: 'APPROVED',
              submitted_at: '2024-12-27T11:00:00Z',
            },
          ],
          reviewDecision: 'APPROVED',
          reviewDecisionFetchedAt: new Date().toISOString(),
        },
        'notif-4': {
          notificationUpdatedAt: mixedFixture.notifications[3].updated_at,
          lastReadAt: mixedFixture.notifications[3].last_read_at || null,
          unread: true,
          allComments: false,
          fetchedAt: new Date().toISOString(),
          comments: [],
          reviews: [],
          reviewDecision: 'REVIEW_REQUIRED',
          reviewDecisionFetchedAt: new Date().toISOString(),
        },
      },
    };

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, commentCache);
    await page.reload();

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    // Default view is Issues, which shows 3 items from the fixture
    await expect(page.locator('.notification-item')).toHaveCount(3);
  });

  test('j/k moves the active selection', async ({ page }) => {
    await page.keyboard.press('j');

    await expect(page.locator('.notification-item').first()).toHaveClass(/keyboard-selected/);
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(1);

    await page.keyboard.press('j');
    await expect(page.locator('.notification-item').nth(1)).toHaveClass(/keyboard-selected/);
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(1);

    await page.keyboard.press('k');
    await expect(page.locator('.notification-item').first()).toHaveClass(/keyboard-selected/);
  });

  test('e marks the active notification as done', async ({ page }) => {
    let releaseReload: () => void = () => {};
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    await page.route('**/notifications/html/repo/**', async (route) => {
      await reloadGate;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
      });
    });

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

    await page.keyboard.press('j');
    await page.keyboard.press('e');

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Checking for new comments');
    await expect(statusBar).not.toHaveClass(/auto-dismiss/);
    releaseReload();

    await expect(statusBar).toContainText('Done 1/1 (0 pending)');
    await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
  });

  test('m unsubscribes the active approved notification', async ({ page }) => {
    await page.route(
      '**/github/rest/notifications/threads/**/subscription',
      (route) => {
        route.fulfill({ status: 204 });
      }
    );
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

    // Switch to Others' PRs view and approved subfilter to see notif-2
    await page.locator('#view-others-prs').click();
    const othersPrsSubfilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    await othersPrsSubfilters.locator('[data-subfilter="approved"]').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    await page.keyboard.press('j');
    await page.keyboard.press('m');

    await expect(page.locator('[data-id="notif-2"]')).not.toBeAttached();
  });

  test('r refreshes the page', async ({ page }) => {
    const navigationPromise = page.waitForNavigation();
    await page.keyboard.press('r');
    await navigationPromise;

    // After reload, the page should be in a valid state with repo preserved from localStorage
    await expect(page.locator('#repo-input')).toHaveValue('test/repo');
  });

  test('marking middle notification as done moves selection to next, not first', async ({
    page,
  }) => {
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

    // Navigate to the middle notification (notif-3)
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/keyboard-selected/);

    // Mark as done - selection should move to notif-5, not notif-1
    await page.keyboard.press('e');

    // Wait for the notification to be removed
    await expect(page.locator('[data-id="notif-3"]')).not.toBeAttached();

    // The selection should be on notif-5 (the next one), NOT notif-1 (the first one)
    await expect(page.locator('[data-id="notif-5"]')).toHaveClass(/keyboard-selected/);
    await expect(page.locator('[data-id="notif-1"]')).not.toHaveClass(/keyboard-selected/);
  });

  test('Enter opens the active notification in a new tab', async ({ page, context }) => {
    // Navigate to first notification
    await page.keyboard.press('j');
    await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/keyboard-selected/);

    // Listen for new page (popup/tab)
    const pagePromise = context.waitForEvent('page');

    // Press Enter to open the notification
    await page.keyboard.press('Enter');

    // Verify new tab was opened with the correct URL
    const newPage = await pagePromise;
    expect(newPage.url()).toBe(
      'https://github.com/test/repo/issues/42?notification_referrer_id=NT_test_42'
    );
  });

  test('Enter does nothing when no notification is selected', async ({ page, context }) => {
    // Verify no notification is selected
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(0);

    // Set up a promise that will reject if a new page opens
    let newPageOpened = false;
    context.on('page', () => {
      newPageOpened = true;
    });

    // Press Enter
    await page.keyboard.press('Enter');

    // Wait a moment to ensure no page opens
    await page.waitForTimeout(100);

    // No new page should have opened
    expect(newPageOpened).toBe(false);
  });

  test('G (shift+g) scrolls to the bottom of the page', async ({ page }) => {
    // Set viewport to be small enough that scrolling is needed
    await page.setViewportSize({ width: 800, height: 300 });

    // Verify we start at the top
    const scrollTopBefore = await page.evaluate(() => window.scrollY);
    expect(scrollTopBefore).toBe(0);

    // Press G (shift+g) to scroll to bottom
    await page.keyboard.press('Shift+G');

    // Wait for scroll animation to complete (150ms + buffer)
    await page.waitForTimeout(200);

    // Verify we scrolled down
    const scrollTopAfter = await page.evaluate(() => window.scrollY);
    expect(scrollTopAfter).toBeGreaterThan(0);
  });

  test('gg (two g presses) scrolls to the top of the page', async ({ page }) => {
    // Set viewport to be small enough that scrolling is needed
    await page.setViewportSize({ width: 800, height: 300 });

    // First scroll down using G
    await page.keyboard.press('Shift+G');
    await page.waitForTimeout(200);
    const scrollTopAfterG = await page.evaluate(() => window.scrollY);
    expect(scrollTopAfterG).toBeGreaterThan(0);

    // Press gg to scroll to top
    await page.keyboard.press('g');
    await page.keyboard.press('g');

    // Wait for scroll animation to complete (150ms + buffer)
    await page.waitForTimeout(200);

    // Verify we're back at the top
    const scrollTopAfterGG = await page.evaluate(() => window.scrollY);
    expect(scrollTopAfterGG).toBe(0);
  });

  test('gg does not change keyboard selection', async ({ page }) => {
    // Navigate to middle notification
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/keyboard-selected/);

    // Press gg to scroll to top
    await page.keyboard.press('g');
    await page.keyboard.press('g');

    // Selection should still be on notif-3
    await expect(page.locator('[data-id="notif-3"]')).toHaveClass(/keyboard-selected/);
  });

  test('single g press does not scroll', async ({ page }) => {
    // Set viewport to be small enough that scrolling is needed
    await page.setViewportSize({ width: 800, height: 300 });

    // First scroll down
    await page.keyboard.press('Shift+G');
    const scrollTopBefore = await waitForScrollSettled(page);
    expect(scrollTopBefore).toBeGreaterThan(0);

    // Press g once and wait
    await page.keyboard.press('g');
    const scrollTopAfter = await waitForScrollSettled(page, { timeoutMs: 1200 });

    // Scroll position should not have changed
    expect(scrollTopAfter).toBe(scrollTopBefore);
  });

  test('t toggles selection of active notification', async ({ page }) => {
    // Navigate to first notification
    await page.keyboard.press('j');
    await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/keyboard-selected/);

    // Verify checkbox is not checked initially
    const checkbox = page.locator('[data-id="notif-1"] .notification-checkbox');
    await expect(checkbox).not.toBeChecked();

    // Press t to toggle selection
    await page.keyboard.press('t');

    // Checkbox should now be checked
    await expect(checkbox).toBeChecked();
    // Check for 'selected' as a word boundary (not just substring match)
    await expect(page.locator('[data-id="notif-1"]')).toHaveClass(/\bselected\b/);

    // Press t again to uncheck
    await page.keyboard.press('t');

    // Checkbox should be unchecked again
    await expect(checkbox).not.toBeChecked();
  });

  test('t does nothing when no notification is selected', async ({ page }) => {
    // Verify no notification is keyboard-selected
    await expect(page.locator('.notification-item.keyboard-selected')).toHaveCount(0);

    // Press t
    await page.keyboard.press('t');

    // No notifications should have checkboxes checked
    await expect(page.locator('.notification-checkbox:checked')).toHaveCount(0);
  });

  test('? opens the keyboard shortcuts help overlay', async ({ page }) => {
    const overlay = page.locator('#keyboard-shortcuts-overlay');

    // Overlay should not be visible initially
    await expect(overlay).not.toHaveClass(/visible/);

    // Press ? (shift+/) to open the overlay
    await page.keyboard.press('?');

    // Overlay should now be visible
    await expect(overlay).toHaveClass(/visible/);

    // Verify the overlay contains expected content
    await expect(page.locator('#keyboard-shortcuts-title')).toHaveText('Keyboard Shortcuts');
    await expect(page.locator('.keyboard-shortcuts-section')).toHaveCount(4); // Navigation, Actions, Selection, Help
  });

  test('Escape closes the keyboard shortcuts help overlay', async ({ page }) => {
    const overlay = page.locator('#keyboard-shortcuts-overlay');

    // Open the overlay
    await page.keyboard.press('?');
    await expect(overlay).toHaveClass(/visible/);

    // Press Escape to close
    await page.keyboard.press('Escape');

    // Overlay should no longer be visible
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('clicking close button closes the keyboard shortcuts overlay', async ({ page }) => {
    const overlay = page.locator('#keyboard-shortcuts-overlay');

    // Open the overlay
    await page.keyboard.press('?');
    await expect(overlay).toHaveClass(/visible/);

    // Click the close button
    await page.locator('#keyboard-shortcuts-close').click();

    // Overlay should no longer be visible
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('clicking outside the modal closes the keyboard shortcuts overlay', async ({ page }) => {
    const overlay = page.locator('#keyboard-shortcuts-overlay');

    // Open the overlay
    await page.keyboard.press('?');
    await expect(overlay).toHaveClass(/visible/);

    // Click on the overlay backdrop (outside the modal)
    await overlay.click({ position: { x: 10, y: 10 } });

    // Overlay should no longer be visible
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('Escape closes overlay before clearing selection', async ({ page }) => {
    const overlay = page.locator('#keyboard-shortcuts-overlay');

    // First, select a notification
    await page.keyboard.press('j');
    await page.keyboard.press('t');
    await expect(page.locator('.notification-checkbox:checked')).toHaveCount(1);

    // Open the overlay
    await page.keyboard.press('?');
    await expect(overlay).toHaveClass(/visible/);

    // Press Escape - should close overlay but NOT clear selection
    await page.keyboard.press('Escape');
    await expect(overlay).not.toHaveClass(/visible/);
    await expect(page.locator('.notification-checkbox:checked')).toHaveCount(1);

    // Press Escape again - now it should clear selection
    await page.keyboard.press('Escape');
    await expect(page.locator('.notification-checkbox:checked')).toHaveCount(0);
  });
});
