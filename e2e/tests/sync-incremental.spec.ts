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

test.describe('Sync Incremental @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('quick sync wires overlap merge into the cached notification list', async ({ page }) => {
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
      makeIssueNotification({
        id: 'prev-3',
        unread: false,
        reason: 'mention',
        updated_at: '2024-12-27T08:00:00Z',
        subject: { title: 'Previous notification 3', number: 3 },
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
    await page.locator('#sync-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Synced 4 notifications');
    await expect(page.locator('[data-id="new-1"]')).toBeVisible();
    expect(requestCount).toBe(1);

    const stored = await readNotificationsCache(page);
    expect((stored as { id: string }[]).map((notif) => notif.id)).toEqual([
      'new-1',
      'api-1',
      'prev-2',
      'prev-3',
    ]);
  });
});
