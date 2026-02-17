import { test, expect } from '@playwright/test';

test.describe('Site auth warning banner', () => {
  test('shows warning when no password and host is non-local', async ({ page }) => {
    await page.setExtraHTTPHeaders({ Host: 'public.example' });
    await page.goto('/site-auth/login');

    const warning = page.locator('.warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('No site password is configured');
  });

  test('does not show warning for localhost', async ({ page }) => {
    await page.goto('/site-auth/login');
    await expect(page.locator('.warning')).toHaveCount(0);
  });
});
