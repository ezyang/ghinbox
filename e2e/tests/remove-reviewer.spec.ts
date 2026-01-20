import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

/**
 * Tests for Remove Reviewer button functionality
 *
 * Tests removing current user as a reviewer from PRs and unsubscribing from the thread.
 */

test.describe('Remove Reviewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
      // Disable comment expansion for PRs to ensure only inline button is visible
      localStorage.setItem('ghnotif_comment_expand_prs', 'false');
    });

    // Mock notifications endpoint
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
      });
    });

    // Mock GraphQL endpoint
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { repository: {} } }),
      });
    });

    // Mock REST comment endpoints
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint
    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    // Mock user endpoint for auth check
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);

    // Sync to load notifications
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    // Switch to Others PRs view to see PR notifications
    await page.locator('#view-others-prs').click();
    // Wait for PR notifications to load (2 PRs in fixture: notif-2 and notif-4)
    await expect(page.locator('.notification-item')).toHaveCount(2);
  });

  test.describe('Button Visibility', () => {
    test('shows remove reviewer button for PR notifications', async ({ page }) => {
      // Find a PR notification (notif-2 is a draft PR in the fixture)
      const prNotification = page.locator('[data-id="notif-2"]');

      // Button should be visible for PRs
      const removeBtn = prNotification.locator('.notification-remove-reviewer-btn');
      await expect(removeBtn).toBeVisible();
    });

    test('does not show remove reviewer button for issue notifications', async ({ page }) => {
      // Switch to Issues view to see issue notifications
      await page.locator('#view-issues').click();

      // Find an issue notification (notif-1 is an issue in the fixture)
      const issueNotification = page.locator('[data-id="notif-1"]');

      // Button should not exist for issues
      const removeBtn = issueNotification.locator('.notification-remove-reviewer-btn');
      await expect(removeBtn).toHaveCount(0);
    });

    test('shows remove reviewer button in bottom actions for PRs', async ({ page }) => {
      // Enable comment expansion
      await page.locator('#comment-expand-prs-toggle').check();

      const prNotification = page.locator('[data-id="notif-2"]');
      const bottomRemoveBtn = prNotification.locator('.notification-remove-reviewer-btn-bottom');

      await expect(bottomRemoveBtn).toBeVisible();
      await expect(bottomRemoveBtn).toContainText('Remove me');
    });
  });

  test.describe('Remove Reviewer Functionality', () => {
    test('removes reviewer and unsubscribes successfully', async ({ page }) => {
      let removeReviewerCalled = false;
      let unsubscribeCalled = false;

      // Mock remove reviewer endpoint
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        if (route.request().method() === 'DELETE') {
          removeReviewerCalled = true;
          route.fulfill({ status: 204 });
        }
      });

      // Mock HTML action endpoint for unsubscribe
      await page.route('**/notifications/html/action', (route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'unsubscribe') {
          unsubscribeCalled = true;
        }
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Wait for completion
      await expect(page.locator('#status-bar')).toContainText('Done');

      // Verify all API calls were made
      expect(removeReviewerCalled).toBe(true);
      expect(unsubscribeCalled).toBe(true);

      // Notification should be removed from UI
      await expect(prNotification).toHaveCount(0);
      await expect(page.locator('.notification-item')).toHaveCount(1);
    });

    test('continues with unsubscribe when reviewer removal fails', async ({ page }) => {
      let unsubscribeCalled = false;
      let removeReviewerCalled = false;

      // Mock remove reviewer endpoint to fail
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        removeReviewerCalled = true;
        route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'User not a reviewer' }),
        });
      });

      // Mock HTML action endpoint for unsubscribe
      await page.route('**/notifications/html/action', (route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'unsubscribe') {
          unsubscribeCalled = true;
        }
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Wait for operation to complete - status eventually shows Done
      await expect(page.locator('#status-bar')).toContainText('Done');

      // Verify remove reviewer was attempted
      expect(removeReviewerCalled).toBe(true);

      // Verify unsubscribe was still called despite reviewer removal failure
      expect(unsubscribeCalled).toBe(true);

      // Notification should still be removed from UI
      await expect(prNotification).toHaveCount(0);
    });

    test('sends correct request body when removing reviewer', async ({ page }) => {
      let requestBody: any = null;

      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', async (route) => {
        if (route.request().method() === 'DELETE') {
          requestBody = await route.request().postDataJSON();
          route.fulfill({ status: 204 });
        }
      });

      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      await expect(page.locator('#status-bar')).toContainText('Done');

      // Verify request body contains current user
      expect(requestBody).toEqual({
        reviewers: ['testuser'],
      });
    });

    test('bottom remove reviewer button works correctly', async ({ page }) => {
      let removeReviewerCalled = false;

      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        if (route.request().method() === 'DELETE') {
          removeReviewerCalled = true;
          route.fulfill({ status: 204 });
        }
      });

      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      // Enable comment expansion
      await page.locator('#comment-expand-prs-toggle').check();

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn-bottom').click();

      await expect(page.locator('#status-bar')).toContainText('Done');
      expect(removeReviewerCalled).toBe(true);
      await expect(prNotification).toHaveCount(0);
    });
  });

  test.describe('Error Handling', () => {
    test('handles rate limiting on remove reviewer', async ({ page }) => {
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Should show rate limit message
      await expect(page.locator('#status-bar')).toContainText('Rate limited');

      // Notification should not be removed
      await expect(prNotification).toBeVisible();
    });

    test('handles unsubscribe failure after successful reviewer removal', async ({ page }) => {
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', error: 'Server error' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Should show unsubscribe failure
      await expect(page.locator('#status-bar')).toContainText('Failed to unsubscribe');

      // Notification should remain visible since unsubscribe failed
      await expect(prNotification).toBeVisible();
    });

    test('shows appropriate error when PR URL is invalid', async ({ page }) => {
      // Modify fixture to have invalid URL
      const invalidFixture = {
        ...mixedFixture,
        notifications: mixedFixture.notifications.map((n) =>
          n.id === 'notif-2'
            ? { ...n, subject: { ...n.subject, url: 'invalid-url' } }
            : n
        ),
      };

      await page.route('**/notifications/html/repo/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(invalidFixture),
        });
      });

      // Reload
      await page.reload();
      await page.locator('#repo-input').fill('test/repo');
      await page.locator('#sync-btn').click();
      // Switch to Others PRs view to see PR notifications
      await page.locator('#view-others-prs').click();
      await expect(page.locator('.notification-item')).toHaveCount(2);

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Should show error
      await expect(page.locator('#status-bar')).toContainText('Failed');
    });
  });

  test.describe('UI State', () => {
    test('button is disabled during operation', async ({ page }) => {
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', async (route) => {
        await new Promise((r) => setTimeout(r, 200));
        route.fulfill({ status: 204 });
      });

      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      const removeBtn = prNotification.locator('.notification-remove-reviewer-btn');

      await removeBtn.click();

      // Button should be disabled during operation
      await expect(removeBtn).toBeDisabled();

      await expect(page.locator('#status-bar')).toContainText('Done');
    });

    test('shows progress status messages', async ({ page }) => {
      await page.route('**/github/rest/repos/**/pulls/*/requested_reviewers', (route) => {
        route.fulfill({ status: 204 });
      });

      await page.route('**/notifications/html/action', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      });

      const prNotification = page.locator('[data-id="notif-2"]');
      await prNotification.locator('.notification-remove-reviewer-btn').click();

      // Should show removing status first
      await expect(page.locator('#status-bar')).toContainText('Removing you as reviewer');

      // Eventually completes
      await expect(page.locator('#status-bar')).toContainText('Done');
    });
  });
});
