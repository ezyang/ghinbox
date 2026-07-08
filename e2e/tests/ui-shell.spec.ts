import { test, expect } from '@playwright/test';
import { addAuthCacheInitScript, APP_STORAGE_KEYS } from './storage-utils';

/**
 * UI shell coverage for the GitHub notifications webapp.
 *
 * Keep this file lean: verify core structure and a couple of key behaviors.
 */

test.describe('UI Shell @layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          login: 'testuser',
          name: 'Test User',
        }),
      });
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          resources: {
            core: {
              remaining: 42,
              limit: 60,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              remaining: 4999,
              limit: 5000,
              resetAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });
    await page.reload();
  });

  test('renders header, controls, and empty notifications list', async ({ page }) => {
    await expect(page.locator('.app-header h1')).toHaveText('ghinbox');
    await expect(page.locator('#profile-select')).toHaveValue('pytorch');
    await expect(page.locator('#repo-input')).toHaveAttribute(
      'placeholder',
      'owner/repo, org:name, or query; one per line'
    );
    await expect(page.locator('#sync-btn')).toHaveText('Quick Sync');
    await expect(page.locator('#server-refresh-btn')).toHaveText('Server Refresh');
    await expect(page.locator('#rate-limit-box')).toContainText('Rate limit: core 42/60');
    // GraphQL rate limit is not fetched on init to save rate limit; shows 'unknown' until first sync
    await expect(page.locator('#rate-limit-box')).toContainText('graphql unknown');
    await expect(page.locator('#notifications-list')).toHaveAttribute('role', 'list');
    await expect(page.locator('#empty-state')).toContainText('No notifications');
    await expect(page.locator('link[href^="notifications.css"]')).toHaveAttribute(
      'href',
      'notifications.css?v=2026-07-08-asset-version-shadow'
    );
    await expect(page.locator('script[src^="notifications-sync.js"]')).toHaveAttribute(
      'src',
      'notifications-sync.js?v=2026-07-08-asset-version-shadow'
    );
  });

  test('force refresh bust survives reload but stale deploy payload does not', async ({
    page,
  }) => {
    const assetVersion = await page.evaluate(() => (window as any).ghnotifAssetVersion);
    const deployedAssetBust = `?v=${encodeURIComponent(assetVersion)}`;

    await page.locator('#force-refresh-btn').click();
    await expect(page).toHaveURL(/cache_bust=/);

    const forceRefreshAssetBust = await page.evaluate(
      () => (window as any).ghnotifAssetBust
    );
    expect(forceRefreshAssetBust).not.toBe(deployedAssetBust);
    await expect(page.locator('script[src^="notifications-sync.js"]')).toHaveAttribute(
      'src',
      `notifications-sync.js${forceRefreshAssetBust}`
    );

    await page.reload();
    await expect(page.locator('script[src^="notifications-sync.js"]')).toHaveAttribute(
      'src',
      `notifications-sync.js${forceRefreshAssetBust}`
    );

    await page.evaluate(() => {
      localStorage.setItem(
        'ghnotif_cache_bust',
        JSON.stringify({
          version: 'previous-deploy',
          bust: 'stale-force-refresh',
        })
      );
      const url = new URL(window.location.href);
      url.searchParams.delete('cache_bust');
      history.replaceState(null, '', url.toString());
    });
    await page.reload();

    await expect(page.locator('script[src^="notifications-sync.js"]')).toHaveAttribute(
      'src',
      `notifications-sync.js${deployedAssetBust}`
    );
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ghnotif_cache_bust')))
      .toBe(null);
  });

  test('toggles and persists dark mode', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');

    await expect(themeToggle).not.toBeChecked();
    await themeToggle.check();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeToggle).toBeChecked();

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ghnotif_theme')))
      .toBe('dark');

    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(1, 4, 9)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeToggle).toBeChecked();
  });
});

test.describe('Repository Input @layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });
    await page.reload();
  });

  test('persists and reloads repository input value', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('vercel/next.js');

    await expect
      .poll(() => page.evaluate((repoKey) => localStorage.getItem(repoKey), APP_STORAGE_KEYS.repo))
      .toBe('vercel/next.js');

    await page.reload();
    await expect(input).toHaveValue('vercel/next.js');
  });
});

test.describe('Sync Button @layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
  });

  test('validates repository input on sync', async ({ page }) => {
    // Clear the repo input first (app defaults to 'pytorch/pytorch' when localStorage is empty)
    await page.locator('#repo-input').fill('');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Please enter a repository');

    await page.locator('#repo-input').fill('invalid-format');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Invalid format');
  });
});

test.describe('Auth Status @layout', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to ensure fresh auth check (auth is cached with TTL)
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('ghnotif_cache');
    });
  });

  test('shows authenticated state when user is logged in', async ({ page }) => {
    await addAuthCacheInitScript(page);

    // Mock user endpoint as fallback if cache lookup fails
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toContainText('Signed in as testuser');
    await expect(authStatus).toHaveClass(/authenticated/);
  });

  test('shows error state when not authenticated', async ({ page }) => {
    await addAuthCacheInitScript(page, null);

    await page.goto('notifications.html');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toContainText('Not authenticated');
    await expect(authStatus).toHaveClass(/error/);
  });
});
