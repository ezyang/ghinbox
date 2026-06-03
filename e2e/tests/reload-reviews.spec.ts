import { test, expect } from '@playwright/test';
import { openNotificationsWithCachedData, subfilterTab, viewTab } from './app-fixture';

test.describe('Reload reviews button @sync', () => {
  test('refreshes review requests without reloading all notifications', async ({ page }) => {
    await openNotificationsWithCachedData(page, {
      notifications: [],
      expectedCount: 0,
    });

    await page.unroute('**/notifications/html/repo/**').catch(() => undefined);
    await page.unroute('**/github/graphql').catch(() => undefined);

    let notificationReloads = 0;
    let reviewSearches = 0;

    await page.route('**/notifications/html/repo/**', (route) => {
      notificationReloads++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          notifications: [],
          pagination: { has_next: false, after_cursor: null },
        }),
      });
    });

    await page.route('**/github/rest/search/issues**', (route) => {
      reviewSearches++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              number: 101,
              title: 'Review me',
              html_url: 'https://github.com/test/repo/pull/101',
              pull_request: { url: 'https://api.github.com/repos/test/repo/pulls/101' },
              user: { login: 'alice', avatar_url: '' },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-02T00:00:00Z',
            },
          ],
        }),
      });
    });

    await page.route('**/github/graphql', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2026-01-02T01:00:00Z',
            },
            repository: {
              pr101: {
                state: 'OPEN',
                isDraft: false,
                reviewDecision: null,
                authorAssociation: 'MEMBER',
                additions: 12,
                deletions: 3,
                changedFiles: 2,
                author: { login: 'alice' },
                labels: { nodes: [] },
              },
            },
          },
        }),
      })
    );

    await page.route('**/github/rest/repos/test/repo/collaborators/alice/permission', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'write' }),
      })
    );

    await viewTab(page, 'others-prs').click();
    const reloadReviewsBtn = page.locator('#reload-reviews-btn');
    await expect(reloadReviewsBtn).toBeVisible();

    await reloadReviewsBtn.click();

    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('.notification-item')).toContainText('Review me');
    await expect(page.locator('#status-bar')).toContainText('Reloaded 1 review notification');
    expect(reviewSearches).toBe(1);
    expect(notificationReloads).toBe(0);
  });

  test('streams review search results before metadata refresh finishes', async ({ page }) => {
    await openNotificationsWithCachedData(page, {
      notifications: [],
      expectedCount: 0,
    });

    await page.unroute('**/github/graphql').catch(() => undefined);

    let resolveGraphql: (() => void) | null = null;
    let shouldHoldGraphql = true;
    const graphqlStarted = new Promise<void>((resolve) => {
      page.route('**/github/graphql', async (route) => {
        resolve();
        if (shouldHoldGraphql) {
          await new Promise<void>((release) => {
            resolveGraphql = () => {
              shouldHoldGraphql = false;
              release();
            };
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              rateLimit: {
                limit: 5000,
                remaining: 4999,
                resetAt: '2026-01-02T01:00:00Z',
              },
              repository: {
                pr101: {
                  state: 'OPEN',
                  isDraft: false,
                  reviewDecision: null,
                  authorAssociation: 'MEMBER',
                  additions: 12,
                  deletions: 3,
                  changedFiles: 2,
                  author: { login: 'alice' },
                  labels: { nodes: [{ name: 'mergedog' }] },
                },
              },
            },
          }),
        });
      });
    });

    await page.route('**/github/rest/search/issues**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              number: 101,
              title: 'Review me incrementally',
              html_url: 'https://github.com/test/repo/pull/101',
              pull_request: { url: 'https://api.github.com/repos/test/repo/pulls/101' },
              user: { login: 'alice', avatar_url: '' },
              author_association: 'MEMBER',
              labels: [{ name: 'mergedog' }],
              state: 'open',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-02T00:00:00Z',
            },
          ],
        }),
      })
    );

    await page.route('**/github/rest/repos/test/repo/collaborators/alice/permission', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'write' }),
      })
    );

    await viewTab(page, 'others-prs').click();
    await page.locator('#reload-reviews-btn').click();
    await graphqlStarted;

    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('.notification-item')).toContainText('Review me incrementally');
    await subfilterTab(page, 'others-prs', 'done', 'state').click();
    await expect(page.locator('.notification-item')).toHaveCount(1);

    resolveGraphql?.();
    await expect(page.locator('#status-bar')).toContainText('Reloaded 1 review notification');
  });
});
