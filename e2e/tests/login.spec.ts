import { test, expect } from '@playwright/test';

/**
 * E2E tests for the login flow.
 *
 * These tests verify the login page loads correctly and the API endpoints
 * respond appropriately. They don't actually log in to GitHub since that
 * would require real credentials.
 */

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    // Mock needs-login to return true so the login page stays visible
    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: true,
          account: 'default',
        }),
      });
    });
  });

  test('renders login form with username and password inputs', async ({ page }) => {
    await page.goto('login.html');

    await expect(page.locator('h1')).toHaveText('Sign in to GitHub');
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#credentials-form button[type="submit"]')).toHaveText('Sign in');
  });

  test('2FA form is hidden initially', async ({ page }) => {
    await page.goto('login.html');

    await expect(page.locator('#twofa-form')).toBeHidden();
    await expect(page.locator('#credentials-form')).toBeVisible();
  });

  test('success state is hidden initially', async ({ page }) => {
    await page.goto('login.html');

    await expect(page.locator('#success-state')).toBeHidden();
  });

  test('mobile wait form is hidden initially', async ({ page }) => {
    await page.goto('login.html');

    await expect(page.locator('#mobile-wait-form')).toBeHidden();
  });
});

test.describe('Login API Endpoints', () => {
  test('GET /auth/needs-login returns needs_login status', async ({ request }) => {
    const response = await request.get('/auth/needs-login');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty('needs_login');
    expect(data).toHaveProperty('account');
    // In test mode, the response depends on whether auth state exists
    // Just verify the shape of the response
    expect(typeof data.needs_login).toBe('boolean');
  });

  test('POST /auth/login/start creates a session', async ({ request }) => {
    const response = await request.post('/auth/login/start', {
      data: { account: 'default' },
    });
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty('session_id');
    expect(data).toHaveProperty('status');
    expect(data.status).toBe('initialized');
  });

  test('GET /auth/login/status returns 404 for invalid session', async ({ request }) => {
    const response = await request.get('/auth/login/status/invalid-session-id');
    expect(response.status()).toBe(404);
  });

  test('POST /auth/login/credentials returns 404 for invalid session', async ({ request }) => {
    const response = await request.post('/auth/login/credentials', {
      data: {
        session_id: 'invalid-session-id',
        username: 'test',
        password: 'test',
      },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /auth/login/2fa returns 404 for invalid session', async ({ request }) => {
    const response = await request.post('/auth/login/2fa', {
      data: {
        session_id: 'invalid-session-id',
        code: '123456',
      },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /auth/login/cancel returns 404 for invalid session', async ({ request }) => {
    const response = await request.post('/auth/login/cancel', {
      data: { session_id: 'invalid-session-id' },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /auth/login/mobile-wait returns 404 for invalid session', async ({ request }) => {
    const response = await request.post('/auth/login/mobile-wait', {
      data: {
        session_id: 'invalid-session-id',
        timeout_seconds: 10,
      },
    });
    expect(response.status()).toBe(404);
  });
});

test.describe('Login Page Navigation', () => {
  test('stays on login page when already authenticated', async ({ page }) => {
    // Mock the needs-login endpoint to return false (already authenticated)
    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: false,
          account: 'default',
        }),
      });
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.goto('login.html');

    await expect(page).toHaveURL(/\/app\/login\.html$/);
    await expect(page.locator('#credentials-form')).toBeVisible();
  });

  test('stays on login page when auth file exists but GitHub user is unavailable', async ({
    page,
  }) => {
    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: false,
          account: 'default',
        }),
      });
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Not authenticated' }),
      });
    });

    await page.goto('login.html');

    await expect(page).toHaveURL(/\/app\/login\.html$/);
    await expect(page.locator('#credentials-form')).toBeVisible();
  });

  test('successful login clears stale not-authenticated cache before returning to notifications', async ({
    page,
  }) => {
    let needsLogin = true;

    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: null, timestamp: Date.now() })
      );
    });

    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: needsLogin,
          account: 'default',
        }),
      });
    });

    await page.route('**/auth/login/start', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'initialized',
          session_id: 'test-session',
        }),
      });
    });

    await page.route('**/auth/login/credentials', (route) => {
      needsLogin = false;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          username: 'testuser',
        }),
      });
    });

    await page.route('**/auth/reload', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
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

    await page.goto('login.html');
    await page.locator('#username').fill('testuser');
    await page.locator('#password').fill('password');
    await page.locator('#credentials-form button[type="submit"]').click();

    await expect(page).toHaveURL(/\/app\/notifications\.html$/);
    await expect(page.locator('#auth-status')).toContainText('Signed in as testuser');
    await expect(page.locator('#auth-status')).toHaveClass(/authenticated/);
  });

  test('session refresh login uses configured account when starting GitHub login', async ({
    page,
  }) => {
    let startedAccount: string | undefined;

    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: false,
          account: 'work-account',
        }),
      });
    });

    await page.route('**/auth/login/start', async (route) => {
      const body = route.request().postDataJSON() as { account?: string };
      startedAccount = body.account;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'initialized',
          session_id: 'refresh-session',
        }),
      });
    });

    await page.route('**/auth/login/credentials', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          error: 'stop after start',
        }),
      });
    });

    await page.goto('login.html?session_refresh=1');
    await page.locator('#username').fill('testuser');
    await page.locator('#password').fill('password');
    await page.locator('#credentials-form button[type="submit"]').click();

    await expect.poll(() => startedAccount).toBe('work-account');
  });

  test('back to login button returns to credentials form', async ({ page }) => {
    // Mock needs-login to keep login page visible
    await page.route('**/auth/needs-login', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          needs_login: true,
          account: 'default',
        }),
      });
    });

    await page.goto('login.html');

    // Wait for page to be ready
    await expect(page.locator('#credentials-form')).toBeVisible();

    // Manually show 2FA form to test back button
    await page.evaluate(() => {
      document.getElementById('credentials-form')!.hidden = true;
      document.getElementById('twofa-form')!.hidden = false;
    });

    await expect(page.locator('#twofa-form')).toBeVisible();

    // Click back button
    await page.locator('#back-to-login').click();

    // Should show credentials form again
    await expect(page.locator('#credentials-form')).toBeVisible();
    await expect(page.locator('#twofa-form')).toBeHidden();
  });
});
