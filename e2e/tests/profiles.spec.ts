import { test, expect } from '@playwright/test';
import {
  captureHtmlActions,
  makeNotification,
  makeNotificationsResponse,
  mockDefaultApiRoutes,
  viewTab,
} from './app-fixture';
import { clearAppStorage } from './storage-utils';

function makeProfileNotification(id: string, repo: string, title: string, number: number) {
  const [owner, name] = repo.split('/');
  return makeNotification({
    id,
    reason: 'mention',
    updated_at: `2025-01-0${number}T12:00:00Z`,
    repository: { owner, name, full_name: repo },
    subject: {
      title,
      type: 'Issue',
      number,
    },
    repo,
  });
}

function response(repo: string, notifications: unknown[]) {
  return makeNotificationsResponse(
    notifications,
    {
      generated_at: '2025-01-01T00:00:00Z',
      authenticity_token: 'token',
    },
    repo
  );
}

test.describe('Notification Profiles @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockDefaultApiRoutes(page);
    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('ships pytorch and everything-else profile defaults', async ({ page }) => {
    await expect(page.locator('#profile-select')).toHaveValue('pytorch');
    await expect(page.locator('#repo-input')).toHaveValue('org:pytorch\norg:meta-pytorch');

    await page.locator('#profile-select').selectOption('everything-else');
    await expect(page.locator('#repo-input')).toHaveValue('-org:pytorch -org:meta-pytorch');
  });

  test('syncs all entries in the active profile', async ({ page }) => {
    const seenQueries: string[] = [];
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const repo = query === 'org:pytorch' ? 'pytorch/pytorch' : 'meta-pytorch/test';
      const title = query === 'org:pytorch' ? 'PyTorch issue' : 'Meta PyTorch issue';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          response(repo, [
            makeProfileNotification(`notif-${seenQueries.length}`, repo, title, seenQueries.length),
          ])
        ),
      });
    });

    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(2);
    expect(seenQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });

  test('full sync supports the default PyTorch profile', async ({ page }) => {
    const seenQueries: string[] = [];
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const repo = query === 'org:pytorch' ? 'pytorch/pytorch' : 'meta-pytorch/test';
      const title = query === 'org:pytorch' ? 'PyTorch issue' : 'Meta PyTorch issue';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(repo, [
          makeProfileNotification(`notif-full-${seenQueries.length}`, repo, title, seenQueries.length),
        ])),
      });
    });

    await page.locator('#full-sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(2);
    expect(seenQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });

  test('full sync loads review requests for query profiles', async ({ page }) => {
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      const repo = query === 'org:pytorch' ? 'pytorch/pytorch' : 'meta-pytorch/test';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(repo, [])),
      });
    });

    const reviewRequestQueries: string[] = [];
    await page.route('**/github/rest/review-requests**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      reviewRequestQueries.push(query);
      const notifications = query === 'org:pytorch'
        ? [{
            id: 'review-request:pytorch/pytorch#7',
            unread: false,
            reason: 'review_requested',
            responsibility_source: 'review-requested',
            updated_at: '2025-01-05T12:00:00Z',
            last_read_at: null,
            repository: { owner: 'pytorch', name: 'pytorch', full_name: 'pytorch/pytorch' },
            subject: {
              title: 'Needs my review',
              url: 'https://github.com/pytorch/pytorch/pull/7',
              type: 'PullRequest',
              number: 7,
              state: 'open',
              state_reason: null,
            },
            actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
            ui: { saved: false, done: false, action_tokens: {} },
          }]
        : [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notifications }),
      });
    });
    await page.route('**/github/rest/notifications**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );

    await page.locator('#full-sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await viewTab(page, 'others-prs').click();
    await expect(page.locator('[data-id="review-request:pytorch/pytorch#7"]')).toBeVisible();
    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
    expect(reviewRequestQueries).toEqual(['org:pytorch', 'org:meta-pytorch']);
  });

  test('inline mark done works with a multi-query profile', async ({ page }) => {
    const notification = makeProfileNotification(
      'notif-multi-done',
      'pytorch/pytorch',
      'PyTorch issue',
      1
    );
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      const notifications = query === 'org:pytorch' ? [notification] : [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('pytorch/pytorch', notifications)),
      });
    });

    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(1);

    // The sync-before-done reload must target the notification's own repo,
    // not require a single-repo profile.
    const reloadedRepos: string[] = [];
    await page.route('**/notifications/html/repo/**', (route) => {
      const match = route.request().url().match(/\/notifications\/html\/repo\/([^/]+)\/([^/?]+)/);
      if (match) {
        reloadedRepos.push(`${match[1]}/${match[2]}`);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('pytorch/pytorch', [notification])),
      });
    });
    const actions = await captureHtmlActions(page);

    await page
      .locator('[data-id="notif-multi-done"] .notification-actions-inline .notification-done-btn')
      .click();

    await expect(page.locator('#status-bar')).toContainText('Marked as done');
    await expect(page.locator('[data-id="notif-multi-done"]')).toHaveCount(0);
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'archive',
        notification_ids: ['notif-multi-done'],
      }),
    ]);
    expect(reloadedRepos).toContain('pytorch/pytorch');
  });

  test('remembers custom profiles with multiple repositories', async ({ page }) => {
    await page.locator('#profile-select').selectOption('custom');
    await page.locator('#repo-input').fill('test/repo\nother/repo');

    await page.reload();

    await expect(page.locator('#profile-select')).toHaveValue('custom');
    await expect(page.locator('#repo-input')).toHaveValue('test/repo\nother/repo');
    await expect.poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('ghnotif_profiles') || '[]'))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom',
          entries: ['test/repo', 'other/repo'],
        }),
      ])
    );
  });
});
