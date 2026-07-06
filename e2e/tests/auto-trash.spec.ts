import { test, expect } from '@playwright/test';
import {
  mockDefaultApiRoutes,
  mockGraphqlReviewMetadata,
} from './app-fixture';
import {
  addAuthCacheInitScript,
  APP_STORAGE_KEYS,
  clearAppStorage,
  readNotificationsCache,
  seedCommentCache,
} from './storage-utils';

const makePrNotification = (
  id: string,
  number: number,
  title: string,
  reason: string,
  state = 'open'
) => ({
  id,
  unread: true,
  reason,
  updated_at: `2025-01-08T12:0${number}:00Z`,
  last_read_at: '2025-01-08T08:00:00Z',
  subject: {
    title,
    url: `https://github.com/test/repo/pull/${number}`,
    type: 'PullRequest',
    number,
    state,
    state_reason: null,
  },
  actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
  ui: {
    saved: false,
    done: false,
    action_tokens: {
      archive: 'test-csrf-token',
      unarchive: 'test-csrf-token',
      subscribe: 'test-csrf-token',
      unsubscribe: 'test-csrf-token',
    },
  },
});

const notifications = [
  makePrNotification('my-pr-no-new', 1, 'Own PR with only bot comments', 'author'),
  makePrNotification('my-pr-own-and-bot', 7, 'Own PR with only own and bot actions', 'author'),
  makePrNotification('pr-for-others', 2, 'PR notification for another user', 'comment'),
  makePrNotification('others-approved', 3, 'Approved PR', 'review_requested'),
  makePrNotification('others-draft', 4, 'Draft PR', 'review_requested', 'draft'),
  makePrNotification('others-closed', 5, 'Closed PR', 'review_requested', 'closed'),
  makePrNotification('needs-review', 6, 'PR still needing review', 'review_requested'),
  {
    id: 'closed-issue-bot-cc',
    unread: true,
    reason: 'mention',
    updated_at: '2025-01-08T12:09:00Z',
    last_read_at: '2025-01-08T08:00:00Z',
    subject: {
      title: 'Closed issue with top-level bot-style cc',
      url: 'https://github.com/test/repo/issues/9',
      type: 'Issue',
      number: 9,
      state: 'closed',
      state_reason: 'completed',
    },
    actors: [{ login: 'issue-author', avatar_url: 'https://avatars.githubusercontent.com/u/9?v=4' }],
    ui: {
      saved: false,
      done: false,
      action_tokens: {
        archive: 'test-csrf-token',
        unarchive: 'test-csrf-token',
        subscribe: 'test-csrf-token',
        unsubscribe: 'test-csrf-token',
      },
    },
  },
  {
    id: 'commit-mention',
    unread: true,
    reason: 'mention',
    updated_at: '2025-01-08T12:08:00Z',
    last_read_at: '2025-01-08T08:00:00Z',
    subject: {
      title: '[BE][Ez]: Remove redundant contiguous copies (#175500)',
      url: 'https://github.com/test/repo/commit/1e6a58483ef40e5db042eb688ca26fab8a0e6f88?notification_referrer_id=NT_commit',
      type: 'Commit',
      number: null,
      state: null,
      state_reason: null,
    },
    actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
    ui: {
      saved: false,
      done: false,
      action_tokens: {
        archive: 'test-csrf-token',
        unarchive: 'test-csrf-token',
        subscribe: 'test-csrf-token',
        unsubscribe: 'test-csrf-token',
      },
    },
  },
];

const notificationsResponse = {
  source_url: 'https://github.com/notifications?query=repo:test/repo',
  generated_at: '2025-01-08T00:00:00Z',
  repository: {
    owner: 'test',
    name: 'repo',
    full_name: 'test/repo',
  },
  notifications,
  pagination: {
    before_cursor: null,
    after_cursor: null,
    has_previous: false,
    has_next: false,
  },
};
let currentNotificationsResponse = notificationsResponse;

const freshIso = new Date().toISOString();
const commentCache = {
  version: 1,
  threads: {
    'my-pr-no-new': {
      notificationUpdatedAt: '2025-01-08T12:01:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'testuser',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 101,
          created_at: '2025-01-08T10:00:00Z',
          body: 'CI finished successfully.',
          user: { login: 'github-actions[bot]' },
        },
      ],
    },
    'my-pr-own-and-bot': {
      notificationUpdatedAt: '2025-01-08T12:07:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'testuser',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 701,
          created_at: '2025-01-08T09:00:00Z',
          body: 'CI finished successfully.',
          user: { login: 'htmlpurifierbot' },
        },
        {
          id: 702,
          created_at: '2025-01-08T10:00:00Z',
          body: 'Rebased and pushed the fix.',
          user: { login: 'testuser' },
        },
      ],
    },
    'pr-for-others': {
      notificationUpdatedAt: '2025-01-08T12:02:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 201,
          created_at: '2025-01-08T10:00:00Z',
          body: 'General update for another reviewer.',
          user: { login: 'bob' },
        },
      ],
    },
    'others-approved': {
      notificationUpdatedAt: '2025-01-08T12:03:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      reviewDecision: 'APPROVED',
      reviewDecisionFetchedAt: freshIso,
      comments: [],
      reviews: [
        {
          id: 301,
          state: 'APPROVED',
          submitted_at: '2025-01-08T10:00:00Z',
          user: { login: 'reviewer1' },
        },
      ],
    },
    'others-draft': {
      notificationUpdatedAt: '2025-01-08T12:04:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [],
    },
    'others-closed': {
      notificationUpdatedAt: '2025-01-08T12:05:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [],
    },
    'needs-review': {
      notificationUpdatedAt: '2025-01-08T12:06:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      authorLogin: 'alice',
      authorLoginFetchedAt: freshIso,
      comments: [
        {
          id: 601,
          created_at: '2025-01-08T09:00:00Z',
          body: 'Can you adjust this?',
          user: { login: 'testuser' },
        },
        {
          id: 602,
          created_at: '2025-01-08T10:00:00Z',
          body: 'Updated, please take another look.',
          user: { login: 'alice' },
        },
      ],
    },
    'closed-issue-bot-cc': {
      notificationUpdatedAt: '2025-01-08T12:09:00Z',
      lastReadAt: '2025-01-08T08:00:00Z',
      fetchedAt: freshIso,
      allComments: true,
      comments: [
        {
          id: 901,
          created_at: '2025-01-08T10:00:00Z',
          updated_at: '2025-01-08T10:00:00Z',
          isIssue: true,
          body: 'Bug report details.\n\ncc @testuser @another-reviewer',
          user: { login: 'issue-author' },
        },
      ],
    },
  },
};

test.describe('Low-priority cleanup @mutation', () => {
  test.beforeEach(async ({ page }) => {
    currentNotificationsResponse = notificationsResponse;

    await addAuthCacheInitScript(page);
    await mockDefaultApiRoutes(page, { notifications: notificationsResponse });
    await mockGraphqlReviewMetadata(page, {});

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentNotificationsResponse),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, commentCache);
    await page.reload();
  });

  test('cleans low-priority notifications after sync when enabled', async ({ page }) => {
    let archivedIds: string[] = [];
    await page.route('**/notifications/html/action', (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'archive') {
        archivedIds = body.notification_ids;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await expect(page.locator('#auto-clean-low-priority-toggle')).toBeChecked();
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect
      .poll(async () => {
        const stored = await readNotificationsCache(page);
        return Array.isArray(stored) ? stored.length : 0;
      })
      .toBe(1);
    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
    await page.locator('#view-others-prs').click();
    await expect(page.locator('[data-id="needs-review"]')).toBeVisible();
    await expect(page.locator('#view-cleaned .count')).toHaveText('8');
    await page.locator('#view-cleaned').click();
    await expect(page.locator('.notification-item')).toHaveCount(8);
    await expect(page.locator('[data-id="closed-issue-bot-cc"]')).toBeVisible();
    await expect(page.locator('[data-id="commit-mention"]')).toBeVisible();
    await expect(page.locator('[data-id="my-pr-no-new"]')).toBeVisible();
    await expect(page.locator('[data-id="my-pr-own-and-bot"]')).toBeVisible();
    await expect(page.locator('[data-id="pr-for-others"]')).toBeVisible();
    await expect(page.locator('[data-id="others-approved"]')).toBeVisible();
    await expect(page.locator('[data-id="others-draft"]')).toBeVisible();
    await expect(page.locator('[data-id="others-closed"]')).toBeVisible();

    expect(archivedIds.sort()).toEqual([
      'closed-issue-bot-cc',
      'commit-mention',
      'my-pr-no-new',
      'my-pr-own-and-bot',
      'others-approved',
      'others-closed',
      'others-draft',
      'pr-for-others',
    ]);

    const stored = await readNotificationsCache(page);
    expect(Array.isArray(stored)).toBe(true);
    if (Array.isArray(stored)) {
      expect(stored.map((item) => item.id)).toEqual(['needs-review']);
    }

    currentNotificationsResponse = {
      ...notificationsResponse,
      notifications: [],
    };
    await page.locator('#sync-btn').click();
    await expect
      .poll(async () => {
        const nextStored = await readNotificationsCache(page);
        return Array.isArray(nextStored) ? nextStored.length : -1;
      })
      .toBe(0);
    await expect(page.locator('#view-cleaned .count')).toHaveText('0');
    await expect(page.locator('.notification-item')).toHaveCount(0);
  });

  test('Clean now button cleans low-priority notifications when auto mode is disabled', async ({ page }) => {
    let archivedIds: string[] = [];
    await page.route('**/notifications/html/action', (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'archive') {
        archivedIds = body.notification_ids;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    });

    await page.evaluate((key) => {
      localStorage.setItem(key, 'false');
    }, APP_STORAGE_KEYS.autoMarkTrash);
    await page.reload();

    await expect(page.locator('#auto-clean-low-priority-toggle')).not.toBeChecked();
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect
      .poll(async () => {
        const stored = await readNotificationsCache(page);
        return Array.isArray(stored) ? stored.length : 0;
      })
      .toBe(9);
    await expect(page.locator('#view-cleaned .count')).toHaveText('0');

    await page.locator('#clean-now-btn').click();

    await expect
      .poll(async () => {
        const stored = await readNotificationsCache(page);
        return Array.isArray(stored) ? stored.length : 0;
      })
      .toBe(1);
    await expect(page.locator('#view-cleaned .count')).toHaveText('8');
    await page.locator('#view-cleaned').click();
    await expect(page.locator('.notification-item')).toHaveCount(8);
    await expect(page.locator('[data-id="closed-issue-bot-cc"]')).toBeVisible();
    await expect(page.locator('[data-id="commit-mention"]')).toBeVisible();
    await expect(page.locator('[data-id="my-pr-own-and-bot"]')).toBeVisible();

    expect(archivedIds.sort()).toEqual([
      'closed-issue-bot-cc',
      'commit-mention',
      'my-pr-no-new',
      'my-pr-own-and-bot',
      'others-approved',
      'others-closed',
      'others-draft',
      'pr-for-others',
    ]);
  });
});
