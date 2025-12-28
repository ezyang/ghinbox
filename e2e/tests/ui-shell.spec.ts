import { test, expect } from '@playwright/test';

/**
 * Phase 2: Basic UI Shell Tests
 *
 * Tests for the main UI structure with GitHub-inspired styling.
 */

test.describe('UI Shell', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.addInitScript(() => {
      localStorage.clear();
    });

    // Mock the auth endpoint to avoid real API calls
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

    await page.goto('notifications.html');
  });

  test.describe('Header', () => {
    test('displays app header with title', async ({ page }) => {
      const header = page.locator('.app-header');
      await expect(header).toBeVisible();

      const title = header.locator('h1');
      await expect(title).toHaveText('Bulk Notifications Editor');
    });

    test('header has dark background (GitHub style)', async ({ page }) => {
      const header = page.locator('.app-header');
      const bgColor = await header.evaluate((el) =>
        getComputedStyle(el).backgroundColor
      );
      // Should be dark (#24292f = rgb(36, 41, 47))
      expect(bgColor).toBe('rgb(36, 41, 47)');
    });
  });

  test.describe('Controls Section', () => {
    test('displays controls section', async ({ page }) => {
      const controls = page.locator('.controls');
      await expect(controls).toBeVisible();
    });

    test('has repository label', async ({ page }) => {
      const label = page.locator('label[for="repo-input"]');
      await expect(label).toBeVisible();
      await expect(label).toHaveText('Repository:');
    });

    test('has repository input field', async ({ page }) => {
      const input = page.locator('#repo-input');
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', 'owner/repo');
    });

    test('has sync button', async ({ page }) => {
      const syncBtn = page.locator('#sync-btn');
      await expect(syncBtn).toBeVisible();
      await expect(syncBtn).toHaveText('Quick Sync');
    });

    test('sync button has primary styling', async ({ page }) => {
      const syncBtn = page.locator('#sync-btn');
      await expect(syncBtn).toHaveClass(/btn-primary/);
    });

    test('has full sync button', async ({ page }) => {
      const fullSyncBtn = page.locator('#full-sync-btn');
      await expect(fullSyncBtn).toBeVisible();
      await expect(fullSyncBtn).toHaveText('Full Sync');
    });

    test('has auth status display', async ({ page }) => {
      const authStatus = page.locator('#auth-status');
      await expect(authStatus).toBeVisible();
    });

    test('shows rate limit info box', async ({ page }) => {
      const rateLimit = page.locator('#rate-limit-box');
      await expect(rateLimit).toBeVisible();
      await expect(rateLimit).toContainText('Rate limit: 42/60');
    });
  });

  test.describe('Notifications Section', () => {
    test('displays notifications container', async ({ page }) => {
      const container = page.locator('.notifications-container');
      await expect(container).toBeVisible();
    });

    test('has notifications header with title', async ({ page }) => {
      const header = page.locator('.notifications-header h2');
      await expect(header).toHaveText('Notifications');
    });

    test('has notification count span', async ({ page }) => {
      const count = page.locator('#notification-count');
      await expect(count).toBeAttached();
    });

    test('has notifications list element', async ({ page }) => {
      const list = page.locator('#notifications-list');
      await expect(list).toBeAttached();
      await expect(list).toHaveAttribute('role', 'list');
    });

    test('shows empty state initially', async ({ page }) => {
      const emptyState = page.locator('#empty-state');
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText('No notifications');
    });

    test('loading state is hidden initially', async ({ page }) => {
      const loading = page.locator('#loading');
      await expect(loading).not.toBeVisible();
    });
  });
});

test.describe('Repository Input', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
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

  test('accepts text input', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('facebook/react');
    await expect(input).toHaveValue('facebook/react');
  });

  test('persists value to localStorage', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('vercel/next.js');

    // Verify localStorage was updated
    const savedValue = await page.evaluate(() =>
      localStorage.getItem('ghnotif_repo')
    );
    expect(savedValue).toBe('vercel/next.js');
  });

  test('loads saved value from localStorage on page load', async ({ page }) => {
    // Set localStorage before navigating
    await page.addInitScript(() => {
      localStorage.setItem('ghnotif_repo', 'saved/repo');
    });

    await page.goto('notifications.html');

    const input = page.locator('#repo-input');
    await expect(input).toHaveValue('saved/repo');
  });

  test('can be cleared', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('some/repo');
    await input.clear();
    await expect(input).toHaveValue('');
  });

  test('has focus styles', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.focus();

    // Check that the input has focus
    await expect(input).toBeFocused();
  });
});

test.describe('Sync Button', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
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

  test('is clickable', async ({ page }) => {
    const syncBtn = page.locator('#sync-btn');
    await expect(syncBtn).toBeEnabled();
  });

  test('shows error when clicked without repo input', async ({ page }) => {
    const syncBtn = page.locator('#sync-btn');
    await syncBtn.click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toContainText('Please enter a repository');
    await expect(statusBar).toHaveClass(/error/);
  });

  test('shows error for invalid repo format', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('invalid-format');

    const syncBtn = page.locator('#sync-btn');
    await syncBtn.click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('Invalid format');
  });

  test('triggers sync on Enter key in input', async ({ page }) => {
    const input = page.locator('#repo-input');
    await input.fill('invalid');
    await input.press('Enter');

    // Should show error (validates that Enter triggered sync)
    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toBeVisible();
  });
});

test.describe('Auth Status', () => {
  test('shows authenticated state when user is logged in', async ({ page }) => {
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

    await page.goto('notifications.html');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toContainText('Signed in as testuser');
    await expect(authStatus).toHaveClass(/authenticated/);
  });

  test('shows error state when not authenticated', async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Unauthorized' }),
      });
    });

    await page.goto('notifications.html');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toContainText('Not authenticated');
    await expect(authStatus).toHaveClass(/error/);
  });

  test('shows error state on network failure', async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.abort('failed');
    });

    await page.goto('notifications.html');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toContainText('Auth check failed');
    await expect(authStatus).toHaveClass(/error/);
  });
});

test.describe('Status Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
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

  test('is hidden initially', async ({ page }) => {
    const statusBar = page.locator('#status-bar');
    await expect(statusBar).not.toBeVisible();
  });

  test('shows error style for errors', async ({ page }) => {
    const syncBtn = page.locator('#sync-btn');
    await syncBtn.click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toHaveClass(/error/);
  });
});

test.describe('Responsive Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('notifications.html');
  });

  test('container has max-width constraint', async ({ page }) => {
    const container = page.locator('.container');
    const maxWidth = await container.evaluate((el) =>
      getComputedStyle(el).maxWidth
    );
    expect(maxWidth).toBe('1012px');
  });

  test('controls wrap on narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });

    const controlsRow = page.locator('.controls-row').first();
    const flexWrap = await controlsRow.evaluate((el) =>
      getComputedStyle(el).flexWrap
    );
    expect(flexWrap).toBe('wrap');
  });
});
