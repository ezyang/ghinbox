import { test, expect } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage } from './storage-utils';

test.describe('Query State', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/notifications/html/repo/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mixedFixture),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('loads repo and filters from the query string', async ({ page }) => {
    await page.goto(
      'notifications.html?view=others-prs&state=approved&author=external&repo=test/repo'
    );

    await expect(page.locator('#repo-input')).toHaveValue('test/repo');
    await expect(page.locator('#view-others-prs')).toHaveClass(/active/);

    const statusFilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    const authorFilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
    );
    await expect(statusFilters.locator('[data-subfilter="approved"]')).toHaveClass(/active/);
    await expect(authorFilters.locator('[data-subfilter="external"]')).toHaveClass(/active/);
  });

  test('updates the query string when filters change', async ({ page }) => {
    await page.goto('notifications.html');

    const repoInput = page.locator('#repo-input');
    await repoInput.fill('test/repo');

    await page.locator('#view-others-prs').click();
    const othersPrsStatus = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    const othersPrsAuthor = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
    );
    await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
    await othersPrsAuthor.locator('[data-subfilter="committer"]').click();

    await page.waitForFunction(() => {
      const params = new URLSearchParams(window.location.search);
      return (
        params.get('view') === 'others-prs' &&
        params.get('repo') === 'test/repo' &&
        params.get('state') === 'needs-review' &&
        params.get('author') === 'committer'
      );
    });
  });
});
