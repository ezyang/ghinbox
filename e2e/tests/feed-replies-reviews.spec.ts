import { test, expect } from '@playwright/test';
import { clearAppStorage, seedCommentCache } from './storage-utils';

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2026-05-14T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications: [
    {
      id: 'pr-body-cc',
      unread: true,
      reason: 'mention',
      updated_at: '2026-05-14T12:00:00Z',
      last_read_at: '2026-05-14T08:00:00Z',
      subject: {
        title: 'Top-level PR body CC',
        url: 'https://github.com/test/repo/pull/1',
        type: 'PullRequest',
        number: 1,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'mid-thread-mention',
      unread: true,
      reason: 'comment',
      updated_at: '2026-05-14T12:10:00Z',
      last_read_at: '2026-05-14T08:00:00Z',
      subject: {
        title: 'Comment mentions the user',
        url: 'https://github.com/test/repo/issues/2',
        type: 'Issue',
        number: 2,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'authored-issue-reply',
      unread: true,
      reason: 'author',
      updated_at: '2026-05-14T12:20:00Z',
      last_read_at: '2026-05-14T08:00:00Z',
      subject: {
        title: "Authored issue with someone else's reply",
        url: 'https://github.com/test/repo/issues/4',
        type: 'Issue',
        number: 4,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'dana', avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'main-thread-new-cc',
      unread: true,
      reason: 'comment',
      updated_at: '2026-05-14T12:30:00Z',
      last_read_at: '2026-05-14T08:00:00Z',
      subject: {
        title: 'Main thread comment cc mentions the user',
        url: 'https://github.com/test/repo/issues/5',
        type: 'Issue',
        number: 5,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'erin', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'main-thread-immediate-reply',
      unread: true,
      reason: 'comment',
      updated_at: '2026-05-14T12:40:00Z',
      last_read_at: '2026-05-14T08:00:00Z',
      subject: {
        title: 'Main thread immediate reply after my comment',
        url: 'https://github.com/test/repo/issues/6',
        type: 'Issue',
        number: 6,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'frank', avatar_url: 'https://avatars.githubusercontent.com/u/6?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'main-thread-later-chatter',
      unread: true,
      reason: 'comment',
      updated_at: '2026-05-14T12:50:00Z',
      last_read_at: '2026-05-14T09:05:00Z',
      subject: {
        title: 'Main thread later chatter after my comment',
        url: 'https://github.com/test/repo/issues/7',
        type: 'Issue',
        number: 7,
        state: 'open',
        state_reason: null,
      },
      actors: [{ login: 'grace', avatar_url: 'https://avatars.githubusercontent.com/u/7?v=4' }],
      ui: { saved: false, done: false },
    },
    {
      id: 'symbolic-export-followup',
      unread: true,
      reason: 'mention',
      updated_at: '2026-05-13T10:58:50Z',
      last_read_at: '2026-05-13T10:00:00Z',
      subject: {
        title:
          'Eager fake-tensor execution on symbolic torch.export metadata can specialize shapes and add guards outside tracing',
        url: 'https://github.com/test/repo/issues/182940',
        type: 'Issue',
        number: 182940,
        state: 'open',
        state_reason: null,
      },
      actors: [
        { login: 'oscarandersson8218', avatar_url: 'https://avatars.githubusercontent.com/u/8?v=4' },
      ],
      ui: { saved: false, done: false },
    },
  ],
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};

const freshIso = new Date().toISOString();
const commentCache = {
  version: 1,
  threads: {
    'pr-body-cc': {
      notificationUpdatedAt: '2026-05-14T12:00:00Z',
      lastReadAt: '2026-05-14T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [],
    },
    'mid-thread-mention': {
      notificationUpdatedAt: '2026-05-14T12:10:00Z',
      lastReadAt: '2026-05-14T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 200,
          created_at: '2026-05-14T09:00:00Z',
          updated_at: '2026-05-14T09:00:00Z',
          body: '@testuser can you take a look at this?',
          user: { login: 'bob' },
        },
      ],
    },
    'authored-issue-reply': {
      notificationUpdatedAt: '2026-05-14T12:20:00Z',
      lastReadAt: '2026-05-14T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 400,
          created_at: '2026-05-14T09:30:00Z',
          updated_at: '2026-05-14T09:30:00Z',
          body: 'I can reproduce this.',
          user: { login: 'dana' },
        },
      ],
    },
    'main-thread-new-cc': {
      notificationUpdatedAt: '2026-05-14T12:30:00Z',
      lastReadAt: '2026-05-14T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 500,
          created_at: '2026-05-14T09:00:00Z',
          updated_at: '2026-05-14T09:00:00Z',
          body: 'cc @testuser for visibility',
          user: { login: 'erin' },
        },
      ],
    },
    'main-thread-immediate-reply': {
      notificationUpdatedAt: '2026-05-14T12:40:00Z',
      lastReadAt: '2026-05-14T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 600,
          created_at: '2026-05-14T08:30:00Z',
          updated_at: '2026-05-14T08:30:00Z',
          body: 'I can help debug this.',
          user: { login: 'testuser' },
        },
        {
          id: 601,
          created_at: '2026-05-14T09:00:00Z',
          updated_at: '2026-05-14T09:00:00Z',
          body: 'Thanks, here are more details.',
          user: { login: 'frank' },
        },
      ],
    },
    'main-thread-later-chatter': {
      notificationUpdatedAt: '2026-05-14T12:50:00Z',
      lastReadAt: '2026-05-14T09:05:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 700,
          created_at: '2026-05-14T08:30:00Z',
          updated_at: '2026-05-14T08:30:00Z',
          body: 'I can help debug this.',
          user: { login: 'testuser' },
        },
        {
          id: 701,
          created_at: '2026-05-14T09:00:00Z',
          updated_at: '2026-05-14T09:00:00Z',
          body: 'Thanks, here are more details.',
          user: { login: 'frank' },
        },
        {
          id: 702,
          created_at: '2026-05-14T09:10:00Z',
          updated_at: '2026-05-14T09:10:00Z',
          body: 'I have a related question for the group.',
          user: { login: 'grace' },
        },
      ],
    },
    'symbolic-export-followup': {
      notificationUpdatedAt: '2026-05-13T10:58:50Z',
      lastReadAt: '2026-05-13T10:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 1829400,
          created_at: '2026-05-13T10:20:00Z',
          updated_at: '2026-05-13T10:20:00Z',
          body:
            'There is an API on ShapeEnv to freeze it and we should apply it here. Unfortunately this is BC breaking.',
          user: { login: 'testuser' },
        },
        {
          id: 1829401,
          created_at: '2026-05-13T10:58:50Z',
          updated_at: '2026-05-13T10:58:50Z',
          body:
            "Ok, so there's nothing we can do about it at the moment? Unfortunately such eager execution is convenient and used in a few places.",
          user: { login: 'oscarandersson8218' },
        },
      ],
    },
  },
};

const reviewRequestSearch = {
  total_count: 1,
  incomplete_results: false,
  items: [
    {
      number: 3,
      title: 'Needs an explicit review',
      html_url: 'https://github.com/test/repo/pull/3',
      state: 'open',
      draft: false,
      updated_at: '2026-05-14T11:00:00Z',
      created_at: '2026-05-14T10:00:00Z',
      user: { login: 'carol', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4' },
      pull_request: {},
    },
  ],
};

test.describe('Feed, Replies, and Reviews queues @classification', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: 'testuser', timestamp: Date.now() })
      );
    });

    await page.route('**/github/rest/user', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ login: 'testuser' }),
      });
    });

    await page.route('**/github/rest/rate_limit', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rate: { limit: 5000, remaining: 4999, reset: 0 },
          resources: {},
        }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    await page.route('**/github/rest/search/issues**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(reviewRequestSearch),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/*/comments*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4999,
              resetAt: '2026-05-14T00:00:00Z',
            },
            repository: {
              pr1: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
              pr3: {
                reviewDecision: null,
                authorAssociation: 'CONTRIBUTOR',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'carol' },
              },
            },
          },
        }),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, commentCache);
    await page.reload();
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();
    await expect(page.locator('#status-bar')).toContainText('Synced 8 notifications');
  });

  test('separates awareness notifications from directed replies and review requests', async ({
    page,
  }) => {
    await expect(page.locator('#view-issues')).toContainText('Feed');
    await expect(page.locator('#view-pr-notifications')).toContainText('Replies');
    await expect(page.locator('#view-others-prs')).toContainText('Reviews');

    await expect(page.locator('#view-issues .count')).toHaveText('2');
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('5');
    await expect(page.locator('#view-others-prs .count')).toHaveText('1');

    await expect(page.locator('[data-id="pr-body-cc"]')).toBeVisible();
    await expect(page.locator('[data-id="main-thread-later-chatter"]')).toBeVisible();
    await expect(page.locator('[data-id="mid-thread-mention"]')).not.toBeAttached();
    await expect(page.locator('[data-id="authored-issue-reply"]')).not.toBeAttached();
    await expect(page.locator('[data-id="main-thread-new-cc"]')).not.toBeAttached();
    await expect(page.locator('[data-id="main-thread-immediate-reply"]')).not.toBeAttached();
    await expect(page.locator('[data-id="symbolic-export-followup"]')).not.toBeAttached();
    await expect(page.locator('[data-id="review-request:test/repo#3"]')).not.toBeAttached();

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('[data-id="mid-thread-mention"]')).toBeVisible();
    await expect(page.locator('[data-id="authored-issue-reply"]')).toBeVisible();
    await expect(page.locator('[data-id="main-thread-new-cc"]')).toBeVisible();
    await expect(page.locator('[data-id="main-thread-immediate-reply"]')).toBeVisible();
    await expect(page.locator('[data-id="symbolic-export-followup"]')).toBeVisible();
    await expect(page.locator('[data-id="symbolic-export-followup"]')).toContainText(
      'Eager fake-tensor execution on symbolic torch.export metadata'
    );
    await expect(page.locator('[data-id="pr-body-cc"]')).not.toBeAttached();
    await expect(page.locator('[data-id="main-thread-later-chatter"]')).not.toBeAttached();

    await page.locator('#view-others-prs').click();
    await expect(page.locator('[data-id="review-request:test/repo#3"]')).toBeVisible();
    await expect(page.locator('[data-id="pr-body-cc"]')).not.toBeAttached();
  });

  test('comment expansion follows Feed and Replies queues instead of issue and PR types', async ({
    page,
  }) => {
    await expect(page.locator('label[for="comment-expand-issues-toggle"]')).toContainText(
      'Show Feed comments'
    );
    await expect(page.locator('label[for="comment-expand-prs-toggle"]')).toContainText(
      'Show Replies comments'
    );

    await page.locator('#comment-expand-issues-toggle').uncheck();
    await page.locator('#comment-expand-prs-toggle').check();

    await expect(page.locator('[data-id="main-thread-later-chatter"] .comment-item')).toHaveCount(0);

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('[data-id="mid-thread-mention"]')).toBeVisible();
    await expect(page.locator('[data-id="mid-thread-mention"] .comment-item')).toContainText(
      '@testuser can you take a look at this?'
    );
  });

  test('Review comment expansion has its own control', async ({ page }) => {
    await expect(page.locator('label[for="comment-expand-reviews-toggle"]')).toContainText(
      'Show Reviews comments'
    );

    await page.locator('#comment-expand-prs-toggle').uncheck();
    await page.locator('#comment-expand-reviews-toggle').check();

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('[data-id="mid-thread-mention"] .comment-item')).toHaveCount(0);

    await page.locator('#view-others-prs').click();
    await expect(page.locator('[data-id="review-request:test/repo#3"] .comment-item')).toContainText(
      'No comments found.'
    );

    await page.locator('#comment-expand-reviews-toggle').uncheck();
    await expect(page.locator('[data-id="review-request:test/repo#3"] .comment-item')).toHaveCount(0);
  });

  test('moves generic participation replies back to Feed without unsubscribing', async ({
    page,
  }) => {
    const repliesMutedBodies: unknown[] = [];
    let actionCalled = false;

    await page.route('**/notifications/html/repo/test/repo/replies-muted/**', async (route) => {
      repliesMutedBodies.push(await route.request().postDataJSON());
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          repo: 'test/repo',
          notification_id: 'main-thread-immediate-reply',
          replies_muted: true,
        }),
      });
    });
    await page.route('**/notifications/html/action', (route) => {
      actionCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
    });

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('[data-id="main-thread-immediate-reply"]')).toBeVisible();
    await page
      .locator('[data-id="main-thread-immediate-reply"] .notification-actions-inline .notification-move-feed-btn')
      .click();

    await expect.poll(() => repliesMutedBodies.length).toBe(1);
    expect(repliesMutedBodies[0]).toEqual({ replies_muted: true });
    expect(actionCalled).toBe(false);
    await expect(page.locator('[data-id="main-thread-immediate-reply"]')).toBeHidden();
    await expect(page.locator('#view-pr-notifications .count')).toHaveText('4');
    await expect(page.locator('#view-issues .count')).toHaveText('3');

    await page.locator('#view-issues').click();
    await expect(page.locator('[data-id="main-thread-immediate-reply"]')).toBeVisible();

    await page.locator('#view-pr-notifications').click();
    await expect(page.locator('[data-id="main-thread-new-cc"]')).toBeVisible();
    await expect(
      page.locator('[data-id="main-thread-new-cc"] .notification-move-feed-btn')
    ).toHaveCount(0);
  });
});
