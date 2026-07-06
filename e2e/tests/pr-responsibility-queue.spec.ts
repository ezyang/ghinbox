import { test, expect } from '@playwright/test';
import { addAuthCacheInitScript, clearAppStorage } from './storage-utils';
import {
  captureHtmlActions,
  disableAutoClean,
  makeNotification,
  makeNotificationsResponse,
  mockDefaultApiRoutes,
  mockGraphqlReviewMetadata,
  mockNotificationsResponse,
  mockReviewRequests,
  subfilterTab,
  TEST_ACTION_TOKENS,
  viewTab,
} from './app-fixture';

const emptyNotifications = makeNotificationsResponse([]);

const notificationBackedReviewRequest = makeNotificationsResponse([
  makeNotification({
    id: 'notif-review-10',
    reason: 'review_requested',
    updated_at: '2025-01-05T12:30:00Z',
    subject: { title: 'Needs my review', number: 10 },
    actors: [
      { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    ],
    ui: { action_tokens: TEST_ACTION_TOKENS },
  }),
]);

function reviewRequestNotification(
  number: number,
  title: string,
  login: string,
  avatarUrl: string,
  updatedAt: string
) {
  return makeNotification({
    id: `review-request:test/repo#${number}`,
    unread: false,
    reason: 'review_requested',
    responsibility_source: 'review-requested',
    updated_at: updatedAt,
    last_read_at: null,
    repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
    subject: { title, number },
    actors: [{ login, avatar_url: avatarUrl }],
    ui: { action_tokens: {} },
  });
}

const reviewRequests = [
  reviewRequestNotification(10, 'Needs my review', 'alice', 'https://avatars.githubusercontent.com/u/1?v=4', '2025-01-05T12:00:00Z'),
  reviewRequestNotification(11, 'Already approved', 'bob', 'https://avatars.githubusercontent.com/u/2?v=4', '2025-01-05T11:00:00Z'),
  reviewRequestNotification(12, 'Changes requested', 'carol', 'https://avatars.githubusercontent.com/u/3?v=4', '2025-01-05T10:00:00Z'),
  reviewRequestNotification(13, 'Approved but merge queued', 'dana', 'https://avatars.githubusercontent.com/u/4?v=4', '2025-01-05T09:00:00Z'),
];

const reviewRequestPrFields = {
  pr10: {
    reviewDecision: null,
    authorAssociation: 'CONTRIBUTOR',
    additions: 5,
    deletions: 1,
    changedFiles: 1,
    author: { login: 'alice' },
  },
  pr11: {
    reviewDecision: 'APPROVED',
    authorAssociation: 'CONTRIBUTOR',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    author: { login: 'bob' },
  },
  pr12: {
    reviewDecision: 'CHANGES_REQUESTED',
    authorAssociation: 'CONTRIBUTOR',
    additions: 15,
    deletions: 3,
    changedFiles: 2,
    author: { login: 'carol' },
    labels: { nodes: [] },
  },
  pr13: {
    reviewDecision: 'APPROVED',
    authorAssociation: 'CONTRIBUTOR',
    additions: 20,
    deletions: 4,
    changedFiles: 2,
    author: { login: 'dana' },
    labels: { nodes: [{ name: 'mergedog' }] },
  },
};

test.describe('PR responsibility queue @classification @mutation', () => {
  test.beforeEach(async ({ page }) => {
    await addAuthCacheInitScript(page);
    await mockDefaultApiRoutes(page, { notifications: emptyNotifications });
    await mockReviewRequests(page, reviewRequests);
    await mockGraphqlReviewMetadata(page, reviewRequestPrFields);
    await page.route('**/github/rest/repos/test/repo/collaborators/*/permission', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'read', role_name: 'read' }),
      })
    );

    await page.goto('notifications.html');
    await clearAppStorage(page);

    // Auto-clean defaults on and would archive the closed/merged fixture
    // notifications immediately after sync; disable it so counts are stable.
    await disableAutoClean(page);
  });

  test('keeps notification-backed review requests clearable in Reviews', async ({
    page,
  }) => {
    await mockNotificationsResponse(page, notificationBackedReviewRequest);
    const actions = await captureHtmlActions(page);

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 5 notifications');

    await expect(page.locator('#view-pr-notifications .count')).toHaveText('0');
    await expect(page.locator('#view-others-prs .count')).toHaveText('5');

    await viewTab(page, 'others-prs').click();
    await expect(page.locator('[data-id="review-request:test/repo#10"]')).toBeVisible();
    await expect(page.locator('[data-id="notif-review-10"]')).toBeVisible();

    await expect(page.locator('#mark-done-btn')).toBeVisible();
    await page.locator('#mark-done-btn').click();
    await expect(page.locator('[data-id="notif-review-10"]')).not.toBeAttached();
    await expect.poll(() => actions[0]?.action).toBe('archive');
    expect(actions[0]?.notification_ids).toEqual(['notif-review-10']);
  });

  test('removes approved review-requested PRs from needs-review', async ({
    page,
  }) => {
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');

    await viewTab(page, 'others-prs').click();
    const needsReview = subfilterTab(page, 'others-prs', 'needs-review', 'state');
    const approved = subfilterTab(page, 'others-prs', 'approved', 'state');
    const done = subfilterTab(page, 'others-prs', 'done', 'state');
    await expect(needsReview.locator('.count')).toHaveText('2');
    await expect(approved.locator('.count')).toHaveText('2');
    await expect(done.locator('.count')).toHaveText('0');

    await needsReview.click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('[data-id="review-request:test/repo#10"]')).toBeVisible();
    await expect(page.locator('[data-id="review-request:test/repo#11"]')).not.toBeAttached();
    await expect(page.locator('[data-id="review-request:test/repo#12"]')).toBeVisible();

    await approved.click();
    await expect(page.locator('.notification-item')).toHaveCount(2);
    await expect(page.locator('[data-id="review-request:test/repo#11"]')).toBeVisible();
    await expect(page.locator('[data-id="review-request:test/repo#13"]')).toBeVisible();

    await done.click();
    await expect(page.locator('.notification-item')).toHaveCount(0);
    await expect(page.locator('[data-id="review-request:test/repo#13"]')).not.toBeAttached();
  });

  test('does not use search timestamp as review-request comment watermark', async ({
    page,
  }) => {
    const issueCommentRequests: string[] = [];

    await page.route('**/github/rest/repos/test/repo/issues/*/comments*', (route) => {
      issueCommentRequests.push(route.request().url());
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    await expect
      .poll(() => issueCommentRequests.find((url) => url.includes('/issues/10/comments')))
      .toBeTruthy();
    expect(
      issueCommentRequests.find((url) => url.includes('/issues/10/comments'))
    ).not.toContain('since=');
  });

  test('remove me exits a synthetic responsibility item without notification actions', async ({
    page,
  }) => {
    let removeReviewerCalled = false;
    let notificationActionCalled = false;

    await page.route('**/github/rest/repos/test/repo/pulls/10/requested_reviewers', (route) => {
      removeReviewerCalled = true;
      route.fulfill({ status: 204 });
    });
    await page.route('**/notifications/html/action', (route) => {
      notificationActionCalled = true;
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic rows should not call this' }),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');

    await viewTab(page, 'others-prs').click();
    await subfilterTab(page, 'others-prs', 'needs-review', 'state').click();
    const item = page.locator('[data-id="review-request:test/repo#10"]');
    await expect(item).toBeVisible();

    await item.locator('.notification-actions-inline .notification-remove-reviewer-btn').click();
    await expect(item).not.toBeAttached();
    expect(removeReviewerCalled).toBe(true);
    expect(notificationActionCalled).toBe(false);
  });
});
