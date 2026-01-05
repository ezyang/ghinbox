import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, readNotificationsCache } from './storage-utils';

const THREAD_SYNC_PAYLOAD = {
  updated_at: '2000-01-01T00:00:00Z',
  last_read_at: null,
  unread: true,
};

// Fixture with authenticity_token included
const undoToken = 'test-undo-token-12345';
const fixtureWithToken = {
  ...mixedFixture,
  authenticity_token: 'test-csrf-token-12345',
  notifications: mixedFixture.notifications.map((notification) => ({
    ...notification,
    ui: {
      ...notification.ui,
      action_tokens: {
        ...notification.ui?.action_tokens,
        unarchive: undoToken,
        subscribe: undoToken,
      },
    },
  })),
};

/**
 * Undo Tests
 *
 * Tests for undo functionality after marking notifications as done or unsubscribing.
 */

test.describe('Undo', () => {
  test.beforeEach(async ({ page }) => {
    // Mock auth endpoint
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    // Mock notifications endpoint with token
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixtureWithToken),
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

    // Mock mark done API
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204 });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
  });

  test.describe('Undo via Keyboard', () => {
    test('pressing u triggers undo', async ({ page }) => {
      // Mock the undo action endpoint
      await page.route('**/notifications/html/action', (route) => {
        const body = route.request().postDataJSON();
        expect(body.action).toBe('unarchive');
        expect(body.notification_ids).toEqual(['notif-1']);
        expect(body.authenticity_token).toBe(undoToken);
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Mark as done
      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      // Press u to undo
      await page.keyboard.press('u');

      // Notification should be restored
      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });

    test('pressing u does nothing when no undo available', async ({ page }) => {
      // Just press u without any action
      await page.keyboard.press('u');

      // Nothing should happen
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('u key is ignored when typing in input', async ({ page }) => {
      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      // Focus on repo input and type 'u'
      await page.locator('#repo-input').focus();
      await page.keyboard.press('u');

      // Undo should NOT be triggered
      await expect(page.locator('.notification-item')).toHaveCount(2);
    });
  });

  test.describe('Undo Stack', () => {
    test('only most recent action can be undone', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Mark two notifications as done
      let markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-3"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(1);

      // Undo should only restore the second one
      await page.keyboard.press('u');
      await expect(page.locator('.notification-item')).toHaveCount(2);
      await expect(page.locator('[data-id="notif-3"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-1"]')).not.toBeVisible();

      // Second undo should do nothing (stack is empty)
      await page.keyboard.press('u');
      await expect(page.locator('.notification-item')).toHaveCount(2);
    });

  });

  test.describe('Notification Restoration', () => {
    test('restored notification appears in correct sorted position', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Mark the first notification as done
      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      // Undo
      await page.keyboard.press('u');

      // Should be restored to the list
      await expect(page.locator('.notification-item')).toHaveCount(3);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('IndexedDB is updated after undo', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('#status-bar')).toContainText('Done 1/1 (0 pending)');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      let savedNotifications = await readNotificationsCache(page);
      expect((savedNotifications as unknown[]).length).toBe(4);

      // Undo
      await page.keyboard.press('u');
      await expect(page.locator('#status-bar')).toContainText('Undo successful');

      savedNotifications = await readNotificationsCache(page);
      expect((savedNotifications as unknown[]).length).toBe(5);
    });
  });

  test.describe('Token Persistence', () => {
    test('undo after reload uses persisted authenticity token', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        const body = route.request().postDataJSON();
        expect(body.authenticity_token).toBe(undoToken);
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.reload();
      await expect(page.locator('.notification-item')).toHaveCount(3);

      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;

      await page.keyboard.press('u');
      await expect(page.locator('#status-bar')).toContainText('Undo successful');
    });
  });

  test.describe('Undo Error Handling', () => {
    test('undo reports action errors and preserves the undo stack', async ({ page }) => {
      let undoCalls = 0;
      await page.route('**/notifications/html/action', (route) => {
        undoCalls += 1;
        if (undoCalls === 1) {
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              detail: 'No fetcher configured. Start server with --account to enable actions.',
            }),
          });
          return;
        }
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const markDoneResponse = page.waitForResponse((response) => response.url().includes('/github/rest/notifications/threads/') && response.request().method() === 'DELETE');
      await page.locator('[data-id="notif-1"] .notification-actions-inline .notification-done-btn').click();
      await markDoneResponse;
      await expect(page.locator('.notification-item')).toHaveCount(2);

      await page.keyboard.press('u');
      await expect(page.locator('#status-bar')).toContainText('Undo failed:');
      await expect(page.locator('#status-bar')).toContainText('No fetcher configured');
      await expect(page.locator('.notification-item')).toHaveCount(2);

      await page.keyboard.press('u');
      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      await expect(page.locator('.notification-item')).toHaveCount(3);
    });
  });
});
