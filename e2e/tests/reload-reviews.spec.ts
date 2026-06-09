import { test, expect } from '@playwright/test';
import { openNotificationsWithCachedData, subfilterTab, viewTab } from './app-fixture';

function reviewRequestNotification({
  repo = 'test/repo',
  number,
  title,
  author = 'alice',
  labels = [],
  updatedAt = '2026-01-02T00:00:00Z',
}: {
  repo?: string;
  number: number;
  title: string;
  author?: string;
  labels?: Array<{ name: string }>;
  updatedAt?: string;
}) {
  const [owner, name] = repo.split('/');
  return {
    id: `review-request:${repo}#${number}`,
    unread: false,
    reason: 'review_requested',
    responsibility_source: 'review-requested',
    updated_at: updatedAt,
    last_read_at: null,
    repository: { owner, name, full_name: repo },
    subject: {
      title,
      url: `https://github.com/${repo}/pull/${number}`,
      type: 'PullRequest',
      number,
      state: 'open',
      state_reason: null,
    },
    actors: [{ login: author, avatar_url: '' }],
    author_association: 'MEMBER',
    labels,
    ui: { saved: false, done: false, action_tokens: {} },
  };
}

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

    await page.route('**/github/rest/review-requests**', (route) => {
      reviewSearches++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          notifications: [reviewRequestNotification({ number: 101, title: 'Review me' })],
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

    await page.route('**/github/rest/review-requests**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          notifications: [
            reviewRequestNotification({
              number: 101,
              title: 'Review me incrementally',
              labels: [{ name: 'mergedog' }],
            }),
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

  test('reloads review requests for each query in the active profile', async ({ page }) => {
    await openNotificationsWithCachedData(page, {
      notifications: [],
      expectedCount: 0,
    });

    await page.unroute('**/github/graphql').catch(() => undefined);

    const seenQueries: string[] = [];
    await page.route('**/github/rest/review-requests**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const isMetaPyTorch = query.includes('org:meta-pytorch');
      const repo = isMetaPyTorch ? 'meta-pytorch/test' : 'pytorch/pytorch';
      const number = isMetaPyTorch ? 301 : 201;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          notifications: [
            reviewRequestNotification({
              repo,
              number,
              title: isMetaPyTorch ? 'Meta PyTorch review' : 'PyTorch review',
              author: isMetaPyTorch ? 'bob' : 'alice',
              updatedAt: isMetaPyTorch ? '2026-01-03T00:00:00Z' : '2026-01-02T00:00:00Z',
            }),
          ],
        }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      const body = route.request().postDataJSON() as { variables?: { owner?: string; name?: string } };
      const owner = body.variables?.owner;
      const name = body.variables?.name;
      const number = owner === 'meta-pytorch' && name === 'test' ? 301 : 201;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2026-01-03T01:00:00Z',
            },
            repository: {
              [`pr${number}`]: {
                state: 'OPEN',
                isDraft: false,
                reviewDecision: null,
                authorAssociation: 'MEMBER',
                additions: 12,
                deletions: 3,
                changedFiles: 2,
                author: { login: number === 301 ? 'bob' : 'alice' },
                labels: { nodes: [] },
              },
            },
          },
        }),
      });
    });

    await page.route('**/github/rest/repos/**/collaborators/**/permission', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'write' }),
      })
    );

    await page.locator('#profile-select').selectOption('pytorch');
    await viewTab(page, 'others-prs').click();
    await page.locator('#reload-reviews-btn').click();

    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('.notification-item')).toContainText('PyTorch review');
    await expect(page.locator('.notification-item')).toContainText('Meta PyTorch review');
    await expect(page.locator('#status-bar')).toContainText('Reloaded 2 review notifications');
    expect(seenQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });
});
