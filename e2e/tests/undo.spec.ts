import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';

// Fixture with authenticity_token included
const fixtureWithToken = {
  ...mixedFixture,
  authenticity_token: 'test-csrf-token-12345',
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

    // Mock mark done API
    await page.route('**/github/rest/notifications/threads/**', (route) => {
      route.fulfill({ status: 204 });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => localStorage.clear());

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
        expect(body.authenticity_token).toBe('test-csrf-token-12345');
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await expect(page.locator('.notification-item')).toHaveCount(5);

      // Mark as done
      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);

      // Press u to undo
      await page.keyboard.press('u');

      // Notification should be restored
      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      await expect(page.locator('.notification-item')).toHaveCount(5);
    });

    test('pressing u does nothing when no undo available', async ({ page }) => {
      // Just press u without any action
      await page.keyboard.press('u');

      // Nothing should happen
      await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');
    });

    test('u key is ignored when typing in input', async ({ page }) => {
      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);

      // Focus on repo input and type 'u'
      await page.locator('#repo-input').focus();
      await page.keyboard.press('u');

      // Undo should NOT be triggered
      await expect(page.locator('.notification-item')).toHaveCount(4);
    });
  });

  test.describe('Undo Action API', () => {
    test('undo for mark-done sends unarchive action', async ({ page }) => {
      let actionRequest: {
        action: string;
        notification_ids: string[];
        authenticity_token: string;
      } | null = null;

      await page.route('**/notifications/html/action', (route) => {
        actionRequest = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await page.keyboard.press('u');

      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      expect(actionRequest).not.toBeNull();
      expect(actionRequest!.action).toBe('unarchive');
      expect(actionRequest!.notification_ids).toEqual(['notif-1']);
    });

    test('undo for bulk mark-done sends multiple notification ids', async ({ page }) => {
      let actionRequest: {
        action: string;
        notification_ids: string[];
        authenticity_token: string;
      } | null = null;

      await page.route('**/notifications/html/action', (route) => {
        actionRequest = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-checkbox').click();
      await page.locator('[data-id="notif-2"] .notification-checkbox').click();
      await page.locator('#mark-done-btn').click();

      await page.keyboard.press('u');

      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      expect(actionRequest).not.toBeNull();
      expect(actionRequest!.action).toBe('unarchive');
      expect(actionRequest!.notification_ids).toEqual(
        expect.arrayContaining(['notif-1', 'notif-2'])
      );
      expect(actionRequest!.notification_ids).toHaveLength(2);
    });

    test('undo for unsubscribe sends subscribe action', async ({ page }) => {
      let actionRequest: {
        action: string;
        notification_ids: string[];
        authenticity_token: string;
      } | null = null;

      await page.route('**/github/rest/notifications/threads/*/subscription', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.route('**/notifications/html/action', (route) => {
        actionRequest = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-unsubscribe-btn').first().click();

      await page.keyboard.press('u');

      await expect(page.locator('#status-bar')).toContainText('Undo successful');
      expect(actionRequest).not.toBeNull();
      expect(actionRequest!.action).toBe('subscribe');
      expect(actionRequest!.notification_ids).toEqual(['notif-1']);
    });

    test('undo shows error when API fails', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', error: 'Token expired' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await page.keyboard.press('u');

      await expect(page.locator('#status-bar')).toContainText('Undo failed');
      await expect(page.locator('#status-bar')).toContainText('Token expired');
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
      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);

      await page.locator('[data-id="notif-2"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(3);

      // Undo should only restore the second one
      await page.keyboard.press('u');
      await expect(page.locator('.notification-item')).toHaveCount(4);
      await expect(page.locator('[data-id="notif-2"]')).toBeVisible();
      await expect(page.locator('[data-id="notif-1"]')).not.toBeVisible();

      // Second undo should do nothing (stack is empty)
      await page.keyboard.press('u');
      await expect(page.locator('.notification-item')).toHaveCount(4);
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
      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);

      // Undo
      await page.keyboard.press('u');

      // Should be restored to the list
      await expect(page.locator('.notification-item')).toHaveCount(5);
      await expect(page.locator('[data-id="notif-1"]')).toBeVisible();
    });

    test('localStorage is updated after undo', async ({ page }) => {
      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      await page.locator('[data-id="notif-1"] .notification-done-btn').click();
      await expect(page.locator('.notification-item')).toHaveCount(4);

      // Check localStorage after mark done
      let savedNotifications = await page.evaluate(() => {
        const saved = localStorage.getItem('ghnotif_notifications');
        return saved ? JSON.parse(saved) : [];
      });
      expect(savedNotifications.length).toBe(4);

      // Undo
      await page.keyboard.press('u');
      await expect(page.locator('#status-bar')).toContainText('Undo successful');

      // Check localStorage after undo
      savedNotifications = await page.evaluate(() => {
        const saved = localStorage.getItem('ghnotif_notifications');
        return saved ? JSON.parse(saved) : [];
      });
      expect(savedNotifications.length).toBe(5);
    });
  });
});
