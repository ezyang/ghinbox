import { test, expect } from '@playwright/test';

test.describe('Site auth warning banner', () => {
  test('shows warning when no password is configured', async ({ page }) => {
    await page.goto('/site-auth/login');

    const warning = page.locator('.warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('No site password is configured');
  });
});
