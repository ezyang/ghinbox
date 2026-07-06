import { test, expect } from '@playwright/test';
import {
  makeCommentCache,
  makeCommentThread,
  makeNotification,
  makeServerSnapshotPayload,
  mockServerSnapshot,
  openCleanSyncPage,
  syncFixtures,
} from './app-fixture';
import {
  APP_STORAGE_KEYS,
  readCommentCache,
  readNotificationsCache,
  seedCommentCache,
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

test.describe('Sync Server Snapshot @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('full sync runs on server and applies returned snapshot', async ({ page }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Server snapshot notification', number: 42 },
    });
    let htmlFetchCalled = false;
    let finishSync!: () => void;
    const syncCanFinish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetchCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    const server = await mockServerSnapshot(page, {
      syncPost: makeServerSnapshotPayload('test/repo', {
        sync: {
          status: 'running',
          mode: 'full',
          pages_fetched: 0,
          notifications_count: 0,
        },
      }),
      syncPolls: [
        makeServerSnapshotPayload('test/repo', {
          sync: {
            status: 'running',
            mode: 'full',
            pages_fetched: 1,
            notifications_count: 1,
          },
        }),
        async () => {
          await syncCanFinish;
          return makeServerSnapshotPayload('test/repo', {
            sync: {
              status: 'success',
              mode: 'full',
              pages_fetched: 1,
              notifications_count: 1,
            },
            snapshot: {
              notifications: [snapshotNotification],
              authenticity_token: 'server-token',
              synced_at: '2024-12-27T12:01:00+00:00',
            },
          });
        },
      ],
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect.poll(() => server.pollCount).toBe(1);
    await expect(page.locator('#status-bar')).toContainText('Full Sync running on server', {
      timeout: 1200,
    });
    finishSync();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect(page.locator('[data-id="server-1"]')).toBeVisible();
    expect(server.postCount).toBe(1);
    expect(htmlFetchCalled).toBe(false);
  });

  test('full sync prunes orphaned comment-cache threads from returned server snapshot', async ({
    page,
  }) => {
    const staleNotification = makeIssueNotification({
      id: 'full-sync-orphan-stale-1',
      updated_at: '2024-12-26T12:00:00Z',
      subject: {
        title: 'Stale local notification',
        number: 41,
      },
    });
    const snapshotNotification = makeIssueNotification({
      id: 'full-sync-current-1',
      updated_at: '2024-12-27T12:00:00Z',
      subject: {
        title: 'Current server snapshot notification',
        number: 42,
      },
    });

    const server = await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo'),
      syncPost: makeServerSnapshotPayload('test/repo', {
        sync: { status: 'running', mode: 'full' },
      }),
      syncPoll: makeServerSnapshotPayload('test/repo', {
        sync: {
          status: 'success',
          mode: 'full',
          phase: 'complete',
          pages_fetched: 1,
          notifications_count: 1,
        },
        snapshot: {
          notifications: [snapshotNotification],
          comment_cache: makeCommentCache({
            'full-sync-current-1': makeCommentThread({
              notificationUpdatedAt: snapshotNotification.updated_at,
              comments: [],
              allComments: true,
              fetchedAt: new Date().toISOString(),
            }),
          }),
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedNotificationsCache(page, [staleNotification]);
    await seedCommentCache(
      page,
      makeCommentCache({
        'full-sync-orphan-stale-1': makeCommentThread({
          notificationUpdatedAt: staleNotification.updated_at,
          comments: [{ id: 501, body: 'Orphan comment for stale notification' }],
          allComments: true,
          fetchedAt: '2024-12-26T12:00:05Z',
        }),
      })
    );
    await seedRepoSelection(page, 'test/repo', { lastSynced: true });
    await page.reload();
    await expect(page.locator('[data-id="full-sync-orphan-stale-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect(page.locator('[data-id="full-sync-current-1"]')).toBeVisible();
    await expect(page.locator('[data-id="full-sync-orphan-stale-1"]')).toHaveCount(0);
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect
      .poll(async () => {
        const cache = (await readCommentCache(page)) as {
          threads?: Record<string, unknown>;
        } | null;
        return [
          Boolean(cache?.threads?.['full-sync-orphan-stale-1']),
          Boolean(cache?.threads?.['full-sync-current-1']),
        ].join(',');
      })
      .toBe('false,true');
    expect(server.postCount).toBe(1);
  });

  test('full sync recovers a rendered list from trashed local state', async ({ page }) => {
    const recoveredNotification = makeIssueNotification({
      id: 'full-sync-recovered-1',
      updated_at: '2024-12-28T12:00:00Z',
      subject: {
        title: 'Recovered upstream notification',
        number: 43,
      },
    });
    const server = await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo'),
      syncPost: makeServerSnapshotPayload('test/repo', {
        sync: { status: 'running', mode: 'full' },
      }),
      syncPoll: makeServerSnapshotPayload('test/repo', {
        sync: {
          status: 'success',
          mode: 'full',
          phase: 'complete',
          pages_fetched: 1,
          notifications_count: 1,
        },
        snapshot: {
          notifications: [recoveredNotification],
          comment_cache: makeCommentCache({
            'full-sync-recovered-1': makeCommentThread({
              notificationUpdatedAt: recoveredNotification.updated_at,
              comments: [],
              allComments: true,
              fetchedAt: new Date().toISOString(),
            }),
          }),
          authenticity_token: 'server-token',
          synced_at: '2024-12-28T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/repos/test/repo/issues/43**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.evaluate((keys) => {
      localStorage.setItem(keys.repo, 'test/repo');
      localStorage.setItem(keys.lastSyncedRepo, 'test/repo');
      localStorage.setItem('ghnotif_profile_id', 'custom');
      localStorage.setItem('ghnotif_profiles', '{"not valid json"');
      localStorage.setItem('ghnotif_view_orders', '{"issues":');
      localStorage.setItem('ghnotif_view_filters', '{"issues":');
      localStorage.setItem('ghnotif_notifications', '{"notifications":');
      localStorage.setItem('ghnotif_bulk_comment_cache_v1', '{"threads":');
      localStorage.setItem('ghnotif_view', 'issues');
    }, APP_STORAGE_KEYS);
    await seedNotificationsCache(page, { not: 'an array' });
    await seedCommentCache(page, { version: 1, threads: 'not a thread map' });
    await page.reload();

    await expect(page.locator('#sync-btn')).toBeEnabled();
    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#full-sync-btn').click();

    await expect(page.locator('[data-id="full-sync-recovered-1"]')).toBeVisible();
    await expect(page.locator('.notification-item')).toHaveCount(1);
    await expect(page.locator('#notification-count')).toContainText('1 notification');
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect
      .poll(async () => {
        const cached = await readNotificationsCache(page);
        return Array.isArray(cached) ? cached.map((item) => item?.id).join(',') : 'not-array';
      })
      .toBe('full-sync-recovered-1');
    await expect
      .poll(async () => {
        const cache = (await readCommentCache(page)) as {
          threads?: Record<string, unknown>;
        } | null;
        return [
          cache?.threads && typeof cache.threads === 'object',
          Boolean(cache?.threads?.['full-sync-recovered-1']),
        ].join(',');
      })
      .toBe('true,true');
    expect(server.postCount).toBe(1);
  });

  test('quick sync runs on server for a single repo when available', async ({ page }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-quick-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Server quick sync notification', number: 42 },
    });
    let htmlFetchCalled = false;
    let finishSync!: () => void;
    const syncCanFinish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetchCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    const server = await mockServerSnapshot(page, {
      syncPost: makeServerSnapshotPayload('test/repo', {
        sync: {
          status: 'running',
          mode: 'full',
          phase: 'notifications',
          pages_fetched: 0,
          notifications_count: 0,
        },
      }),
      syncPolls: [
        makeServerSnapshotPayload('test/repo', {
          sync: {
            status: 'running',
            mode: 'full',
            phase: 'notifications',
            pages_fetched: 1,
            notifications_count: 1,
          },
        }),
        async () => {
          await syncCanFinish;
          return makeServerSnapshotPayload('test/repo', {
            sync: {
              status: 'success',
              mode: 'full',
              phase: 'complete',
              pages_fetched: 1,
              notifications_count: 1,
            },
            snapshot: {
              notifications: [snapshotNotification],
              authenticity_token: 'server-token',
              synced_at: '2024-12-27T12:01:00+00:00',
            },
          });
        },
      ],
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect.poll(() => server.pollCount).toBe(1);
    await expect(page.locator('#status-bar')).toContainText('Quick Sync running on server', {
      timeout: 1200,
    });
    finishSync();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect(page.locator('[data-id="server-quick-1"]')).toBeVisible();
    expect(server.postCount).toBe(1);
    expect(htmlFetchCalled).toBe(false);
  });

  test('server sync applies notification snapshot while comments are still running', async ({
    page,
  }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-running-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Visible before comments finish', number: 42 },
    });
    let bulkCommentRequests = 0;
    let finishSync!: () => void;
    const syncCanFinish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    await page.route('**/github/rest/comments/bulk', (route) => {
      bulkCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: {} }),
      });
    });
    await mockServerSnapshot(page, {
      syncPost: makeServerSnapshotPayload('test/repo', {
        sync: {
          status: 'running',
          mode: 'full',
          phase: 'notifications',
          pages_fetched: 0,
          notifications_count: 0,
        },
      }),
      syncPolls: [
        makeServerSnapshotPayload('test/repo', {
          sync: {
            status: 'running',
            mode: 'full',
            phase: 'comments',
            pages_fetched: 1,
            notifications_count: 1,
            comments_total: 1,
            comments_fetched: 0,
            comments_failed: 0,
          },
          snapshot: {
            notifications: [snapshotNotification],
            authenticity_token: 'server-token',
            synced_at: '2024-12-27T12:00:30+00:00',
          },
        }),
        async () => {
          await syncCanFinish;
          return makeServerSnapshotPayload('test/repo', {
            sync: {
              status: 'success',
              mode: 'full',
              phase: 'complete',
              pages_fetched: 1,
              notifications_count: 1,
              comments_total: 1,
              comments_fetched: 1,
              comments_failed: 0,
            },
            snapshot: {
              notifications: [snapshotNotification],
              comment_cache: {
                version: 1,
                threads: {
                  'server-running-1': {
                    notificationUpdatedAt: '2024-12-27T12:00:00Z',
                    comments: [{ id: 1002, body: 'Fetched by server' }],
                    allComments: true,
                    fetchedAt: new Date().toISOString(),
                  },
                },
              },
              authenticity_token: 'server-token',
              synced_at: '2024-12-27T12:01:00+00:00',
            },
          });
        },
      ],
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    await expect(page.locator('[data-id="server-running-1"]')).toBeVisible();
    await expect(page.locator('#status-bar')).toContainText('comments 0/1');
    expect(bulkCommentRequests).toBe(0);

    finishSync();
    await expect(page.locator('#status-bar')).toContainText('Synced 1 notifications');
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    expect(bulkCommentRequests).toBe(0);
  });

  test('server refresh applies server snapshot without syncing GitHub', async ({ page }) => {
    const staleNotification = makeIssueNotification({
      id: 'server-refresh-stale-1',
      reason: 'mention',
      updated_at: '2024-12-26T12:00:00Z',
      subject: { title: 'Stale local notification', number: 41 },
    });
    const snapshotNotification = makeIssueNotification({
      id: 'server-refresh-current-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Current server snapshot notification', number: 42 },
    });
    let serveSnapshot = false;
    let htmlFetched = false;

    const server = await mockServerSnapshot(page, {
      get: () =>
        makeServerSnapshotPayload('test/repo', {
          snapshot: serveSnapshot
            ? {
                notifications: [snapshotNotification],
                authenticity_token: 'server-token',
                synced_at: '2024-12-27T12:01:00+00:00',
              }
            : null,
        }),
      syncPost: makeServerSnapshotPayload('test/repo'),
    });
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetched = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedNotificationsCache(page, [staleNotification]);
    await seedCommentCache(page, {
      version: 1,
      threads: {
        'server-refresh-stale-1': {
          notificationUpdatedAt: '2024-12-26T12:00:00Z',
          comments: [{ id: 501, body: 'Orphan comment for stale notification' }],
          allComments: true,
          fetchedAt: '2024-12-26T12:00:05Z',
        },
      },
    });
    await seedRepoSelection(page, 'test/repo', { lastSynced: true });
    await page.reload();
    await expect(page.locator('[data-id="server-refresh-stale-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');

    server.getCount = 0;
    serveSnapshot = true;
    await page.locator('#server-refresh-btn').click();

    await expect(page.locator('[data-id="server-refresh-current-1"]')).toBeVisible();
    await expect(page.locator('[data-id="server-refresh-stale-1"]')).toHaveCount(0);
    await expect(page.locator('#status-bar')).toContainText(
      'Loaded 1 notifications from server snapshot'
    );
    const prunedCache = (await readCommentCache(page)) as {
      threads?: Record<string, unknown>;
    } | null;
    expect(prunedCache?.threads?.['server-refresh-stale-1']).toBeUndefined();
    expect(server.getCount).toBeGreaterThan(0);
    expect(server.postCount).toBe(0);
    expect(htmlFetched).toBe(false);
  });

  test('loads server snapshot on startup when local cache is empty', async ({ page }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-startup-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Loaded from server on startup', number: 42 },
    });

    await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [snapshotNotification],
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedRepoSelection(page, 'test/repo');
    await page.reload();

    await expect(page.locator('[data-id="server-startup-1"]')).toBeVisible();
    await expect(page.locator('#status-bar')).toContainText('Loaded server snapshot');
  });

  test('startup server snapshot reuses fresh local comment cache', async ({ page }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-cached-comments-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Loaded with cached comments', number: 42 },
    });
    let bulkCommentRequests = 0;
    let individualCommentRequests = 0;

    await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [snapshotNotification],
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/comments/bulk', (route) => {
      bulkCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: {} }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      individualCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedCommentCache(page, {
      version: 1,
      threads: {
        'server-cached-comments-1': {
          notificationUpdatedAt: '2024-12-27T12:00:00Z',
          comments: [
            {
              id: 1001,
              body: 'Already cached',
              created_at: '2024-12-27T12:00:00Z',
              updated_at: '2024-12-27T12:00:00Z',
              user: { login: 'commenter' },
            },
          ],
          allComments: true,
          fetchedAt: new Date().toISOString(),
        },
      },
    });
    await seedRepoSelection(page, 'test/repo');
    await page.reload();

    await expect(page.locator('[data-id="server-cached-comments-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    expect(bulkCommentRequests).toBe(0);
    expect(individualCommentRequests).toBe(0);
  });

  test('startup server snapshot fetches missing comments in bulk', async ({ page }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-bulk-comments-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Loaded with bulk comments', number: 42 },
    });
    let bulkCommentRequests = 0;
    let individualCommentRequests = 0;

    await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [snapshotNotification],
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/comments/bulk', async (route) => {
      bulkCommentRequests += 1;
      const body = route.request().postDataJSON();
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]).toMatchObject({
        id: 'server-bulk-comments-1',
        subject: {
          number: 42,
          type: 'Issue',
        },
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: {
            'server-bulk-comments-1': {
              comments: [
                {
                  id: 1002,
                  body: 'Fetched in bulk',
                  created_at: '2024-12-27T12:00:00Z',
                  updated_at: '2024-12-27T12:00:00Z',
                  user: { login: 'commenter' },
                },
              ],
              allComments: true,
            },
          },
        }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      individualCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedRepoSelection(page, 'test/repo');
    await page.reload();

    await expect(page.locator('[data-id="server-bulk-comments-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    await expect.poll(() => bulkCommentRequests).toBe(1);
    expect(individualCommentRequests).toBe(0);
  });

  test('startup server snapshot hydrates bundled comment cache without GitHub refetch', async ({
    page,
  }) => {
    const snapshotNotification = makeIssueNotification({
      id: 'server-bundled-comments-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Loaded with bundled comments', number: 42 },
    });
    let bulkCommentRequests = 0;
    let individualCommentRequests = 0;

    await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [snapshotNotification],
          comment_cache: {
            version: 1,
            threads: {
              'server-bundled-comments-1': {
                notificationUpdatedAt: '2024-12-27T12:00:00Z',
                comments: [
                  {
                    id: 1002,
                    body: 'Fetched by server sync',
                    created_at: '2024-12-27T12:00:00Z',
                    updated_at: '2024-12-27T12:00:00Z',
                    user: { login: 'commenter' },
                  },
                ],
                allComments: true,
                fetchedAt: new Date().toISOString(),
              },
            },
          },
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/comments/bulk', (route) => {
      bulkCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: {} }),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      individualCommentRequests += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedRepoSelection(page, 'test/repo');
    await page.reload();

    await expect(page.locator('[data-id="server-bundled-comments-1"]')).toBeVisible();
    await expect(page.locator('#comment-cache-status')).toContainText('Comments cached: 1');
    await expect
      .poll(async () => {
        const cache = (await readCommentCache(page)) as {
          threads?: Record<string, unknown>;
        } | null;
        return Boolean(cache?.threads?.['server-bundled-comments-1']);
      })
      .toBe(true);
    expect(bulkCommentRequests).toBe(0);
    expect(individualCommentRequests).toBe(0);
  });

  test('startup prefers server snapshot over stale local cache without syncing', async ({ page }) => {
    const staleNotification = makeIssueNotification({
      id: 'stale-local-1',
      reason: 'mention',
      updated_at: '2024-12-26T12:00:00Z',
      subject: { title: 'Stale local cache notification', number: 41 },
    });
    const snapshotNotification = makeIssueNotification({
      id: 'server-startup-current-1',
      reason: 'mention',
      updated_at: '2024-12-27T12:00:00Z',
      subject: { title: 'Current server snapshot notification', number: 42 },
    });
    let htmlFetched = false;

    const server = await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [snapshotNotification],
          authenticity_token: 'server-token',
          synced_at: '2024-12-27T12:01:00+00:00',
        },
      }),
      syncPost: makeServerSnapshotPayload('test/repo'),
    });
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      htmlFetched = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponse),
      });
    });
    await page.route('**/github/rest/repos/test/repo/issues/42**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await seedNotificationsCache(page, [staleNotification]);
    await seedRepoSelection(page, 'test/repo', { lastSynced: true });
    await page.evaluate(() => {
      localStorage.setItem(
        'ghnotif_server_snapshot_synced_at:test/repo',
        '2024-12-27T12:01:00+00:00'
      );
    });
    await page.reload();

    await expect(page.locator('[data-id="server-startup-current-1"]')).toBeVisible();
    await expect(page.locator('[data-id="stale-local-1"]')).toHaveCount(0);
    expect(server.postCount).toBe(0);
    expect(htmlFetched).toBe(false);
  });

  test('loads review-request entries from server snapshot into others PRs', async ({ page }) => {
    const reviewRequestNotification = makeIssueNotification({
      id: 'review-request:test/repo#10',
      unread: false,
      reason: 'review_requested',
      responsibility_source: 'review-requested',
      updated_at: '2025-01-05T12:00:00Z',
      last_read_at: '2025-01-05T12:00:00Z',
      subject: {
        title: 'Snapshot review request',
        type: 'PullRequest',
        number: 10,
      },
      actors: [{ login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }],
      ui: { saved: false, done: false, action_tokens: {} },
    });

    await mockServerSnapshot(page, {
      get: makeServerSnapshotPayload('test/repo', {
        snapshot: {
          notifications: [reviewRequestNotification],
          authenticity_token: 'server-token',
          synced_at: '2025-01-05T12:01:00+00:00',
        },
      }),
    });
    await page.route('**/github/rest/repos/test/repo/issues/10/comments*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/github/rest/repos/test/repo/pulls/10/comments*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/github/rest/repos/test/repo/collaborators/alice/permission', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permission: 'write', role_name: 'write' }),
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
              resetAt: '2025-01-05T00:00:00Z',
            },
            repository: {
              pr10: {
                reviewDecision: null,
                authorAssociation: 'MEMBER',
                additions: 5,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'alice' },
              },
            },
          },
        }),
      });
    });

    await seedRepoSelection(page, 'test/repo');
    await page.reload();

    await expect(page.locator('#status-bar')).toContainText('Loaded server snapshot');
    await page.locator('#view-others-prs').click();
    await expect(page.locator('[data-id="review-request:test/repo#10"]')).toBeVisible();
    await expect(page.locator('#view-others-prs .count')).toHaveText('1');
  });
});
