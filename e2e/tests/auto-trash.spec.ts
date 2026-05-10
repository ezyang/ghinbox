import { test, expect } from '@playwright/test';
import {
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
  makePrNotification('pr-for-others', 2, 'PR notification for another user', 'comment'),
  makePrNotification('others-approved', 3, 'Approved PR', 'review_requested'),
  makePrNotification('others-draft', 4, 'Draft PR', 'review_requested', 'draft'),
  makePrNotification('others-closed', 5, 'Closed PR', 'review_requested', 'closed'),
  makePrNotification('needs-review', 6, 'PR still needing review', 'review_requested'),
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
  },
};

test.describe('Auto mark trash done', () => {
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

    await page.route('**/github/rest/search/issues**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.route('**/github/graphql', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4998, resetAt: freshIso } } }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notificationsResponse),
      });
    });

    await page.goto('notifications.html');
    await clearAppStorage(page);
    await seedCommentCache(page, commentCache);
    await page.reload();
  });

  test('archives trash notifications after sync when enabled', async ({ page }) => {
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

    await page.locator('#auto-mark-trash-toggle').check();
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

    expect(archivedIds.sort()).toEqual([
      'my-pr-no-new',
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
  });
});
