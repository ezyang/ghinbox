import { test, expect } from './fixtures';
import { clearAppStorage, readCommentCache, seedCommentCache } from './storage-utils';

test.describe('Comment cache', () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test('clear cache button removes stored comments', async ({ page }) => {
    const repo = 'test/comment-cache-clear';
    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, {
      version: 1,
      threads: {
        '123': {
          fetchedAt: new Date().toISOString(),
          comments: [],
        },
      },
    }, repo);
    // Set repo so loadCommentCache can fetch from server
    await page.evaluate((r) => {
      localStorage.setItem('ghnotif_repo', r);
    }, repo);
    await page.reload();

    const status = page.locator('#comment-cache-status');
    const clearBtn = page.locator('#clear-comment-cache-btn');

    await expect(status).toContainText('Comments cached: 1');
    await expect(clearBtn).toBeEnabled();

    // Set repo in the input so handleClearCommentCache can find it
    await page.locator('#repo-input').fill(repo);
    await clearBtn.click();

    await expect(status).toContainText('Comments cached: 0');
    await expect(clearBtn).toBeDisabled();

    const cachedValue = await readCommentCache(page, repo);
    expect(cachedValue).toBeNull();
  });
});
