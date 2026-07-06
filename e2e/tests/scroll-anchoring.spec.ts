import { test, expect } from '@playwright/test';
import {
  makeNotification,
  makeNotificationsResponse,
  mockHtmlAction,
  openNotificationsWithSync,
} from './app-fixture';

/**
 * Scroll Anchoring Tests
 *
 * When a notification is marked Done and removed from the DOM,
 * the items below it should maintain their visual position in the viewport.
 */

// Generate a fixture with many notifications so we can test scrolling
function generateLargeFixture(count: number) {
  const notifications = [];
  for (let i = 0; i < count; i++) {
    notifications.push(makeNotification({
      actors: [{ avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', login: 'alice' }],
      id: `notif-${i}`,
      reason: 'author',
      subject: {
        number: 100 + i,
        state: 'open',
        state_reason: null,
        title: `Notification item number ${i} with some extra text to make it taller`,
        type: 'Issue',
        url: `https://github.com/test/repo/issues/${100 + i}?notification_referrer_id=NT_test_${i}`,
      },
      ui: {
        action_tokens: {
          archive: 'test-csrf-token',
          subscribe: 'test-csrf-token',
          unarchive: 'test-csrf-token',
          unsubscribe: 'test-csrf-token',
        },
        done: false,
        saved: false,
      },
      updated_at: '2024-12-27T12:00:00Z',
    }));
  }
  return makeNotificationsResponse(notifications, {
    generated_at: '2024-12-27T12:00:00Z',
  });
}

const largeFixture = generateLargeFixture(20);

test.describe('Scroll Anchoring', () => {
  test.beforeEach(async ({ page }) => {
    await mockHtmlAction(page);
    await openNotificationsWithSync(page, {
      expectedCount: 20,
      notifications: largeFixture,
    });
    await expect(page.locator('.notification-item')).toHaveCount(20);
    // Wait for comment prefetch to finish so re-renders don't detach DOM elements
    await expect(page.locator('#comment-cache-status')).toHaveText('Comments cached: 20', { timeout: 10000 });
  });

  // Helper to get an element's viewport Y position via JS
  async function getViewportY(page: import('@playwright/test').Page, dataId: string): Promise<number> {
    return page.evaluate((id) => {
      const el = document.querySelector(`[data-id="${id}"]`);
      if (!el) throw new Error(`Element ${id} not found`);
      return el.getBoundingClientRect().top;
    }, dataId);
  }

  test('inline mark done preserves scroll position of items below', async ({ page }) => {
    // Scroll to the middle of the list
    await page.locator('[data-id="notif-10"]').scrollIntoViewIfNeeded();

    // Get the viewport position of item 11 (the one below what we'll remove)
    const beforeY = await getViewportY(page, 'notif-11');

    // Mark item 10 as done (inline)
    await page.locator('[data-id="notif-10"] .notification-actions-inline .notification-done-btn').click();
    await expect(page.locator('[data-id="notif-10"]')).toHaveCount(0);

    // Item 11 should be at roughly the same viewport position
    const afterY = await getViewportY(page, 'notif-11');
    expect(Math.abs(afterY - beforeY)).toBeLessThan(5);
  });

  test('desktop inline mark done at top of list does not jump viewport upward', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const beforeScrollY = await page.evaluate(() => {
      const firstItem = document.querySelector('[data-id="notif-0"]');
      if (!firstItem) throw new Error('First notification not found');
      const targetY = firstItem.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, targetY);
      return window.scrollY;
    });
    expect(beforeScrollY).toBeGreaterThan(0);

    await page.locator('[data-id="notif-0"] .notification-actions-inline .notification-done-btn').click();
    await expect(page.locator('[data-id="notif-0"]')).toHaveCount(0);

    const afterScrollY = await page.evaluate(() => window.scrollY);
    expect(Math.abs(afterScrollY - beforeScrollY)).toBeLessThan(5);
  });

  test('desktop inline mark done from middle of first entry aligns next entry at top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const removedItemTop = await page.evaluate(() => {
      const firstItem = document.querySelector<HTMLElement>('[data-id="notif-0"]');
      if (!firstItem) throw new Error('First notification not found');
      firstItem.style.minHeight = '1200px';
      const targetY = firstItem.getBoundingClientRect().top + window.scrollY + 250;
      window.scrollTo(0, targetY);
      return firstItem.getBoundingClientRect().top;
    });
    expect(removedItemTop).toBeLessThan(0);

    await page.locator('[data-id="notif-0"] .notification-actions-inline .notification-done-btn').click();
    await expect(page.locator('[data-id="notif-0"]')).toHaveCount(0);

    const nextItemTop = await getViewportY(page, 'notif-1');
    expect(Math.abs(nextItemTop)).toBeLessThan(5);
  });

  test('bulk mark done preserves scroll position of items below', async ({ page }) => {
    await page.locator('[data-id="notif-5"]').scrollIntoViewIfNeeded();

    // Select items 5 and 6
    await page.locator('[data-id="notif-5"] .notification-checkbox').click();
    await page.locator('[data-id="notif-6"] .notification-checkbox').click();

    // Click the mark-done button using dispatchEvent to avoid Playwright
    // auto-scrolling to the button (which is at the top of the page)
    // and changing the viewport position before our anchoring code runs.
    const beforeY = await getViewportY(page, 'notif-7');
    await page.locator('#mark-done-btn').dispatchEvent('click');
    await expect(page.locator('[data-id="notif-5"]')).toHaveCount(0);
    await expect(page.locator('[data-id="notif-6"]')).toHaveCount(0);

    // Item 7 should stay at roughly the same viewport position
    const afterY = await getViewportY(page, 'notif-7');
    expect(Math.abs(afterY - beforeY)).toBeLessThan(5);
  });

  test('keyboard mark done (e key) preserves scroll position', async ({ page }) => {
    await page.locator('[data-id="notif-10"]').scrollIntoViewIfNeeded();
    await page.locator('[data-id="notif-10"]').click();

    // Get viewport position of item 11
    const beforeY = await getViewportY(page, 'notif-11');

    // Press 'e' to mark done
    await page.keyboard.press('e');
    await expect(page.locator('[data-id="notif-10"]')).toHaveCount(0);

    // Item 11 should stay in the same position
    const afterY = await getViewportY(page, 'notif-11');
    expect(Math.abs(afterY - beforeY)).toBeLessThan(5);
  });
});
