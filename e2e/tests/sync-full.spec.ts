import { test, expect } from '@playwright/test';
import { makeNotification, openCleanSyncPage, syncFixtures } from './app-fixture';
import {
  readNotificationsCache,
  seedNotificationsCache,
  seedRepoSelection,
} from './storage-utils';

const { emptyResponse } = syncFixtures;

function makeIssueNotification(options: Parameters<typeof makeNotification>[0]) {
  return makeNotification({
    ...options,
    subject: { type: 'Issue', ...options.subject },
  });
}

test.describe('Sync Full @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('full sync loads every page even with unchanged notifications', async ({ page }) => {
    const previousNotifications = [
      makeIssueNotification({
        id: 'prev-1',
        reason: 'author',
        updated_at: '2024-12-27T10:00:00Z',
        subject: { title: 'Previous notification 1', number: 1 },
      }),
      makeIssueNotification({
        id: 'prev-2',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T09:00:00Z',
        subject: { title: 'Previous notification 2', number: 2 },
      }),
    ];

    await seedRepoSelection(page, 'test/repo', { lastSynced: true });
    await seedNotificationsCache(page, previousNotifications);
    await page.reload();

    const page1Response = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'new-1',
          reason: 'author',
          updated_at: '2024-12-27T11:00:00Z',
          subject: { title: 'New notification', number: 99 },
        }),
        makeIssueNotification({
          id: 'api-1',
          reason: 'author',
          updated_at: '2024-12-27T10:00:00Z',
          subject: { title: 'Previous notification 1', number: 1 },
        }),
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'api-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T09:00:00Z',
          subject: { title: 'API notification 2', number: 2 },
        }),
        makeIssueNotification({
          id: 'api-3',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T08:00:00Z',
          subject: { title: 'API notification 3', number: 3 },
        }),
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let requestCount = 0;
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      const url = route.request().url();

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(url.includes('after=cursor123') ? page2Response : page1Response),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    expect(requestCount).toBe(2);

    const stored = await readNotificationsCache(page);
    expect((stored as { id: string }[]).map((notif) => notif.id)).toEqual([
      'new-1',
      'api-1',
      'api-2',
      'api-3',
    ]);
  });

  test('full sync starts stable comment prefetch before later pages finish', async ({ page }) => {
    const page1Response = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'api-1',
          reason: 'mention',
          updated_at: '2024-12-27T11:00:00Z',
          subject: {
            title: 'Page 1 notification',
            url: 'https://github.com/test/repo/issues/1#issuecomment-101',
            number: 1,
            anchor: 'issuecomment-101',
          },
        }),
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor123',
        has_previous: false,
        has_next: true,
      },
    };

    const page2Response = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'api-2',
          reason: 'mention',
          updated_at: '2024-12-27T10:00:00Z',
          subject: { title: 'Page 2 notification', number: 2 },
        }),
      ],
      pagination: {
        before_cursor: 'cursor123',
        after_cursor: null,
        has_previous: true,
        has_next: false,
      },
    };

    let releasePage2!: () => void;
    const page2Gate = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    let page2Requested = false;
    let commentRequestCount = 0;

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

    await page.route('**/github/rest/repos/test/repo/issues/1', (route) => {
      commentRequestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 101,
          body: 'Issue body',
          created_at: '2024-12-27T09:00:00Z',
          updated_at: '2024-12-27T09:00:00Z',
          user: { login: 'author' },
        }),
      });
    });

    await page.route('**/github/rest/repos/test/repo/issues/1/comments', (route) => {
      commentRequestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 101,
            body: 'Unread comment',
            created_at: '2024-12-27T11:00:00Z',
            updated_at: '2024-12-27T11:00:00Z',
            user: { login: 'commenter' },
          },
        ]),
      });
    });

    await page.route('**/github/rest/notifications**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/notifications/html/repo/test/repo**', async (route) => {
      const url = route.request().url();

      if (url.includes('after=cursor123')) {
        page2Requested = true;
        await page2Gate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(page2Response),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page1Response),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect.poll(() => page2Requested).toBe(true);
    await expect.poll(() => commentRequestCount).toBeGreaterThan(0);

    releasePage2();
    await expect(page.locator('#status-bar')).toContainText('Synced 2 notifications');
    expect(commentRequestCount).toBeGreaterThan(0);
  });

  test('full sync starts review request pull before notification pages resolve', async ({ page }) => {
    let releaseNotifications!: () => void;
    const notificationsCanResolve = new Promise<void>((resolve) => {
      releaseNotifications = resolve;
    });
    let reviewRequestCalled = false;

    await page.route('**/api/snapshots/test/repo/sync', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'No GitHub fetcher configured. Start server with --account.',
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: { owner: 'test', name: 'repo', full_name: 'test/repo' },
          sync: { status: 'idle', mode: 'full' },
          snapshot: null,
        }),
      });
    });

    await page.route('**/github/rest/review-requests?*', (route) => {
      reviewRequestCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notifications: [] }),
      });
    });

    await page.route('**/notifications/html/repo/test/repo**', async (route) => {
      await notificationsCanResolve;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect.poll(() => reviewRequestCalled, { timeout: 1200 }).toBe(true);

    releaseNotifications();
    await expect(page.locator('#status-bar')).toContainText('Synced 0 notifications');
  });
});
