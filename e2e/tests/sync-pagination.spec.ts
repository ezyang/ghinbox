import { test, expect } from '@playwright/test';
import { makeNotification, openCleanSyncPage, syncFixtures } from './app-fixture';
import { readNotificationsCache } from './storage-utils';

const { emptyResponse } = syncFixtures;

function makeIssueNotification(options: Parameters<typeof makeNotification>[0]) {
  return makeNotification({
    ...options,
    subject: { type: 'Issue', ...options.subject },
  });
}

test.describe('Sync Pagination @slow @sync', () => {
  test.beforeEach(async ({ page }) => {
    await openCleanSyncPage(page);
  });

  test('sync traverses multiple pages', async ({ page }) => {
    const page1Response = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'notif-page1-1',
          reason: 'author',
          updated_at: '2024-12-27T12:00:00Z',
          subject: { title: 'Page 1 Notification 1', number: 1 },
        }),
        makeIssueNotification({
          id: 'notif-page1-2',
          unread: false,
          reason: 'mention',
          updated_at: '2024-12-27T11:00:00Z',
          subject: { title: 'Page 1 Notification 2', number: 2 },
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
          id: 'notif-page2-1',
          reason: 'subscribed',
          updated_at: '2024-12-27T10:00:00Z',
          subject: {
            title: 'Page 2 Notification 1',
            number: 3,
            state: 'closed',
            state_reason: 'completed',
          },
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

    await expect(page.locator('#status-bar')).toContainText('Synced 3 notifications');
    expect(requestCount).toBe(2);

    const stored = await readNotificationsCache(page);
    expect((stored as unknown[]).length).toBe(3);
  });

  test('sync stops with an error when the cursor does not advance', async ({ page }) => {
    const repeatingCursorResponse = {
      ...emptyResponse,
      notifications: [
        makeIssueNotification({
          id: 'notif-repeat-cursor',
          reason: 'author',
          updated_at: '2024-12-27T12:00:00Z',
          subject: { title: 'Repeating cursor notification', number: 1 },
        }),
      ],
      pagination: {
        before_cursor: null,
        after_cursor: 'cursor-stuck',
        has_previous: false,
        has_next: true,
      },
    };

    let requestCount = 0;
    await page.route('**/notifications/html/repo/test/repo**', (route) => {
      requestCount += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(repeatingCursorResponse),
      });
    });

    await page.locator('#repo-input').fill('test/repo');
    await page.locator('#sync-btn').click();

    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('pagination cursor did not advance');
    await expect(statusBar).toHaveClass(/error/);
    expect(requestCount).toBe(2);
  });
});
