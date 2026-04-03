import { test, expect } from '@playwright/test';
import { clearAppStorage } from './storage-utils';

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
    notifications.push({
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
      unread: true,
      updated_at: '2024-12-27T12:00:00Z',
    });
  }
  return {
    generated_at: '2024-12-27T12:00:00Z',
    notifications,
    pagination: { after_cursor: null, before_cursor: null, has_next: false, has_previous: false },
    repository: { full_name: 'test/repo', name: 'repo', owner: 'test' },
    source_url: 'https://github.com/notifications?query=repo:test/repo',
  };
}

const largeFixture = generateLargeFixture(20);

test.describe('Scroll Anchoring', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(largeFixture),
      });
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { repository: {} } }),
      });
    });

    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(20);
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

  test('bulk mark done preserves scroll position of items below', async ({ page }) => {
    // Wait for items to be stable, then scroll
    await expect(page.locator('[data-id="notif-5"]')).toBeVisible();
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
    // Wait for item to be stable, then scroll and click
    await expect(page.locator('[data-id="notif-10"]')).toBeVisible();
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
