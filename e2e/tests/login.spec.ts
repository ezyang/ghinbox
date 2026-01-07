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
  test('redirects to main app when already authenticated', async ({ page }) => {
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

    await page.goto('login.html');

    // Should redirect to the main app
    await page.waitForURL('**/app/**', { timeout: 5000 });
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
