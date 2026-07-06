import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

/**
 * Phase 8: Polish Tests
 *
 * Tests for keyboard shortcuts, improved empty states, confirmation dialogs,
 * and other polish items.
 */

test.describe('Polish @layout', () => {
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
      await expect(emptyState).toContainText('No open feed notifications');
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
      await expect(emptyState).toContainText('No closed feed notifications');
      await expect(emptyState).toContainText('still open');
    });
  });


});
