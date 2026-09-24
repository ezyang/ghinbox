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

function makeReviewRequest(repo: string, number: number) {
  const [owner, name] = repo.split('/');
  return {
    id: `review-request:${repo}#${number}`,
    unread: false,
    reason: 'review_requested',
    responsibility_source: 'review-requested',
    updated_at: '2025-01-05T12:00:00Z',
    last_read_at: null,
    repository: { owner, name, full_name: repo },
    subject: {
      title: 'Needs my review',
      url: `https://github.com/${repo}/pull/${number}`,
      type: 'PullRequest',
      number,
      state: 'open',
      state_reason: null,
    },
    actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
    ui: { saved: false, done: false, action_tokens: {} },
  };
}

test.describe('Notification Profiles @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockDefaultApiRoutes(page);
    await page.goto('notifications.html');
    await clearAppStorage(page);
  });

  test('ships an all-notifications default with the PyTorch-family org set', async ({ page }) => {
    await expect(page.locator('#profile-select')).toHaveValue('pytorch');
    await expect(page.locator('#repo-input-group')).toBeHidden();
    await expect(page.locator('#repo-input')).toHaveValue(
      'org:pytorch\norg:meta-pytorch\norg:google-pytorch\n' +
      '-org:pytorch -org:meta-pytorch -org:google-pytorch'
    );

    await page.locator('#profile-select').selectOption('everything-else');
    await expect(page.locator('#repo-input-group')).toBeHidden();
    await expect(page.locator('#repo-input')).toHaveValue(
      '-org:pytorch -org:meta-pytorch -org:google-pytorch'
    );

    await page.locator('#profile-select').selectOption('custom');
    await expect(page.locator('#repo-input-group')).toBeVisible();
  });

  test('ignores persisted edits to built-in notification scopes', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('ghnotif_profiles', JSON.stringify([
        {
          id: 'pytorch',
          name: 'PyTorch',
          entries: ['org:pytorch', 'org:meta-pytorch'],
          system: true,
        },
      ]));
    });

    await page.reload();

    await expect(page.locator('#repo-input')).toHaveValue(
      'org:pytorch\norg:meta-pytorch\norg:google-pytorch\n' +
      '-org:pytorch -org:meta-pytorch -org:google-pytorch'
    );
    await expect(page.locator('#repo-input-group')).toBeHidden();
    await expect(page.locator('#profile-select option:checked')).toHaveText('All notifications');
  });

  test('routes non-PyTorch notifications to Replies in the default profile', async ({ page }) => {
    await page.route('**/notifications/html/query**', (route) => {
      const query = new URL(route.request().url()).searchParams.get('query') || '';
      const isOutsidePyTorch = query.startsWith('-org:pytorch');
      const repo = isOutsidePyTorch ? 'acme/widgets' : 'pytorch/pytorch';
      const notifications = isOutsidePyTorch
        ? [makeProfileNotification('outside-org', repo, 'Outside org issue', 4)]
        : query === 'org:pytorch'
          ? [makeProfileNotification('pytorch-org', repo, 'PyTorch issue', 1)]
          : [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(repo, notifications)),
      });
    });

    await page.locator('#sync-btn').click();

    await expect(page.locator('#view-issues .count')).toHaveText('1');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('1');
    await viewTab(page, 'pr-notifications').click();
    await expect(page.locator('[data-id="outside-org"]')).toBeVisible();
    await expect(page.locator('[data-id="pytorch-org"]')).toHaveCount(0);
  });

  test('syncs all entries in the active profile', async ({ page }) => {
    const seenQueries: string[] = [];
    await page.route('**/notifications/html/query**', (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('query') || '';
      seenQueries.push(query);
      const owner = query.replace(/^-?org:/, '').split(' ')[0];
      const repo = `${owner}/test`;
      const title = `${query} issue`;
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

    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    await expect(page.locator('.notification-item')).toHaveCount(4);
    expect(seenQueries).toEqual([
      'org:pytorch',
      'org:meta-pytorch',
      'org:google-pytorch',
      '-org:pytorch -org:meta-pytorch -org:google-pytorch',
    ]);
  });

  test('sync loads review requests for query profiles', async ({ page }) => {
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
        ? [makeReviewRequest('pytorch/pytorch', 7)]
        : query === 'org:meta-pytorch'
          ? [makeReviewRequest('meta-pytorch/torchchat', 8)]
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

    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    await viewTab(page, 'others-prs').click();
    await expect(page.locator('[data-id="review-request:pytorch/pytorch#7"]')).toBeVisible();
    await expect(page.locator('[data-id="review-request:meta-pytorch/torchchat#8"]')).toBeVisible();
    await expect(page.locator('#view-others-prs .count')).toHaveText('2');
    const priorityFilters = page.locator(
      '.subfilter-tabs[data-for-view="others-prs"][data-subfilter-group="author"]'
    );
    await expect(priorityFilters.locator('[data-subfilter="committer"]')).toContainText(
      /Important\s+1/
    );
    await priorityFilters.locator('[data-subfilter="committer"]').click();
    await expect(page.locator('[data-id="review-request:meta-pytorch/torchchat#8"]')).toBeVisible();
    await expect(page.locator('[data-id="review-request:pytorch/pytorch#7"]')).toHaveCount(0);
    expect(reviewRequestQueries).toEqual([
      'org:pytorch',
      'org:meta-pytorch',
      'org:google-pytorch',
      '-org:pytorch -org:meta-pytorch -org:google-pytorch',
    ]);
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
