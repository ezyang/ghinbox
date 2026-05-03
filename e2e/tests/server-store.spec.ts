import { test, expect } from './fixtures';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

/**
 * Server-side notification persistence tests.
 *
 * Verifies that notifications are persisted to the server-side SQLite store
 * and that mark-done state survives page reloads.
 *
 * The mixed fixture has 5 notifications (3 Issues + 2 PRs).
 * The default view is "issues" which shows only the 3 Issue items.
 * But the server store receives all 5 notifications.
 */

// Use unique repo names per test to avoid cross-test contamination
// (all tests share the same SQLite DB in test mode).

test.describe('Server-Side Store', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    // Mock notifications endpoint
    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
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

    // Mock GraphQL endpoint for prefetch
    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { repository: {} } }),
      });
    });

    // Mock REST comment endpoints for prefetch
    await page.route('**/github/rest/repos/**/issues/*/comments', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Mock REST issues endpoint for prefetch
    await page.route('**/github/rest/repos/**/issues/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, body: '', user: { login: 'testuser' } }),
      });
    });

    // Mock HTML action endpoint (mark done/undo)
    await page.route('**/notifications/html/action', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('sync persists notifications to server store', async ({ page }) => {
    // Use a unique repo name per test run to avoid cross-test contamination
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const repoName = `test/store-sync-${uniqueId}`;
    const repoPath = `test/store-sync-${uniqueId}`;
    await page.locator('#repo-input').fill(repoName);

    // Track whether the PUT to server store completes
    let putSeen = false;
    page.on('response', (resp) => {
      if (resp.url().includes('/api/store/') && resp.request().method() === 'PUT') {
        putSeen = true;
      }
    });

    await page.locator('#sync-btn').click();
    // Issues view shows 3 items (the 3 Issue-type notifications)
    await expect(page.locator('.notification-item')).toHaveCount(3);

    // Wait for the fire-and-forget PUT to complete
    await expect(async () => {
      expect(putSeen).toBe(true);
    }).toPass({ timeout: 5000 });

    // Verify server store has all 5 notifications (Issues + PRs)
    const response = await page.request.get(`/api/store/notifications/${repoPath}`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.notifications).toHaveLength(5);
    expect(data.done_ids).toHaveLength(0);
  });

  test('mark done adds to server done set', async ({ page }) => {
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const repoName = `test/store-done-${uniqueId}`;
    const repoPath = `test/store-done-${uniqueId}`;
    await page.locator('#repo-input').fill(repoName);
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);

    // Select first notification and mark done, waiting for the server POST
    const donePost = page.waitForResponse(
      (resp) => resp.url().includes('/api/store/done/') && resp.request().method() === 'POST'
    );
    await page.locator('[data-id="notif-1"] .notification-checkbox').click();
    await page.locator('#mark-done-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await donePost;

    const response = await page.request.get(`/api/store/notifications/${repoPath}`);
    const data = await response.json();
    expect(data.done_ids).toContain('notif-1');
  });

  test('notifications persist across page reload via server store', async ({ page }) => {
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const repoName = `test/store-reload-${uniqueId}`;
    await page.locator('#repo-input').fill(repoName);
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);

    // Mark one notification done, waiting for the server POST
    const donePost = page.waitForResponse(
      (resp) => resp.url().includes('/api/store/done/') && resp.request().method() === 'POST'
    );
    await page.locator('[data-id="notif-1"] .notification-checkbox').click();
    await page.locator('#mark-done-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await donePost;

    // Clear IndexedDB to simulate a new device — forces load from server store
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    });

    // Set repo before reload so loadNotificationsFromCache can find it
    await page.evaluate((repo) => {
      localStorage.setItem('ghnotif_repo', repo);
      localStorage.setItem('ghnotif_auth_cache', JSON.stringify({ login: 'testuser', timestamp: Date.now() }));
    }, repoName);
    await page.reload();

    // Wait for cached notifications to load from server store.
    // The server returns 4 notifications (5 minus 1 done), and the
    // Issues view shows the 2 remaining Issue items.
    await expect(page.locator('.notification-item')).toHaveCount(2);

    // Verify notif-1 is not shown (it was marked done)
    await expect(page.locator('[data-id="notif-1"]')).toHaveCount(0);
  });

  test('comment cache persists across page reload via server store', async ({ page }) => {
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const repoName = `test/store-comments-${uniqueId}`;
    const repoPath = `test/store-comments-${uniqueId}`;
    await page.locator('#repo-input').fill(repoName);

    // Wait for per-thread comment cache PUTs to the server after sync + prefetch
    const commentPut = page.waitForResponse(
      (resp) => resp.url().includes('/api/store/comments/') && resp.url().includes('/threads/') && resp.request().method() === 'PUT'
    );
    await page.locator('#sync-btn').click();
    await expect(page.locator('.notification-item')).toHaveCount(3);
    await commentPut;

    // Verify server has the comment cache
    const response = await page.request.get(`/api/store/comments/${repoPath}`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Object.keys(data.cache.threads).length).toBeGreaterThan(0);

    // Set repo before reload (server is the only source of truth — no IndexedDB involved)
    await page.evaluate((repo) => {
      localStorage.setItem('ghnotif_repo', repo);
      localStorage.setItem('ghnotif_auth_cache', JSON.stringify({ login: 'testuser', timestamp: Date.now() }));
    }, repoName);
    await page.reload();

    // Notifications should load from server
    await expect(page.locator('.notification-item')).toHaveCount(3);

    // Verify comment cache was restored from server
    const response2 = await page.request.get(`/api/store/comments/${repoPath}`);
    const data2 = await response2.json();
    expect(Object.keys(data2.cache.threads).length).toBeGreaterThan(0);
  });

  test('GET returns empty for unknown repo', async ({ page }) => {
    const response = await page.request.get('/api/store/notifications/unknown/repo');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.notifications).toHaveLength(0);
    expect(data.done_ids).toHaveLength(0);
  });
});
