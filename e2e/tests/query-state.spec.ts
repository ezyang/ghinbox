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
      'notifications.html?view=others-prs&repo=test/repo&issues_state=open&issues_order=recent&my_prs_state=all&my_prs_order=size&others_prs_state=approved&others_prs_author=external&others_prs_order=size'
    );

    await expect(page.locator('#repo-input')).toHaveValue('test/repo');
    await expect(page.locator('#view-others-prs')).toHaveClass(/active/);
    await expect(page.locator('#order-select')).toHaveValue('size');

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

    await page.locator('[data-for-view="issues"][data-subfilter-group="state"] [data-subfilter="open"]').click();
    await page.locator('#order-select').selectOption('size');

    await page.locator('#view-others-prs').click();
    const othersPrsStatus = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="state"]'
    );
    const othersPrsAuthor = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
    );
    await othersPrsStatus.locator('[data-subfilter="needs-review"]').click();
    await othersPrsAuthor.locator('[data-subfilter="committer"]').click();

    await expect(page).toHaveURL(/view=others-prs/);
    await expect(page).toHaveURL(/repo=test%2Frepo/);
    await expect(page).toHaveURL(/issues_state=open/);
    await expect(page).toHaveURL(/issues_order=size/);
    await expect(page).toHaveURL(/others_prs_state=needs-review/);
    await expect(page).toHaveURL(/others_prs_author=committer/);
  });

  test('keeps per-view order when switching tabs', async ({ page }) => {
    await page.goto('notifications.html');

    await page.locator('#order-select').selectOption('size');

    await page.locator('#view-others-prs').click();
    await expect(page.locator('#order-select')).toHaveValue('recent');

    await page.locator('#order-select').selectOption('size');
    await page.locator('#view-issues').click();
    await expect(page.locator('#order-select')).toHaveValue('size');
  });
});
