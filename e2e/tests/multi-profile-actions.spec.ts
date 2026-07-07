import { test, expect, type Page, type Route } from '@playwright/test';
import {
  captureHtmlActions,
  makeNotification,
  makeNotificationsResponse,
  mockDefaultApiRoutes,
  mockQueryNotifications,
  TEST_ACTION_TOKENS,
} from './app-fixture';
import { clearAppStorage } from './storage-utils';

const DEFAULT_PROFILE_INPUT = 'org:pytorch\norg:meta-pytorch';
const QUERY_ORDER = ['org:pytorch', 'org:meta-pytorch'];

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function makeProfileNotification({
  id,
  repo,
  number,
  title,
  updatedAt,
}: {
  id: string;
  repo: string;
  number: number;
  title: string;
  updatedAt: string;
}) {
  const [owner, name] = repo.split('/');
  return makeNotification({
    id,
    repo,
    repository: { owner, name, full_name: repo },
    reason: 'mention',
    updated_at: updatedAt,
    last_read_at: '2025-01-01T00:00:00Z',
    subject: {
      title,
      type: 'Issue',
      number,
      state: 'open',
      state_reason: null,
    },
    ui: {
      action_tokens: TEST_ACTION_TOKENS,
      bookmarked: false,
    },
  });
}

const pytorchNotifications = [
  makeProfileNotification({
    id: 'pt-bulk',
    repo: 'pytorch/pytorch',
    number: 101,
    title: 'PyTorch batch item',
    updatedAt: '2025-01-04T12:00:00Z',
  }),
  makeProfileNotification({
    id: 'pt-unsub',
    repo: 'pytorch/pytorch',
    number: 102,
    title: 'PyTorch unsubscribe item',
    updatedAt: '2025-01-03T12:00:00Z',
  }),
];

const metaPytorchNotifications = [
  makeProfileNotification({
    id: 'meta-bulk',
    repo: 'meta-pytorch/test',
    number: 201,
    title: 'Meta PyTorch batch item',
    updatedAt: '2025-01-02T12:00:00Z',
  }),
  makeProfileNotification({
    id: 'meta-bookmark',
    repo: 'meta-pytorch/test',
    number: 202,
    title: 'Meta PyTorch bookmark item',
    updatedAt: '2025-01-01T12:00:00Z',
  }),
];

const allNotifications = [...pytorchNotifications, ...metaPytorchNotifications];

function queryResponse(repo: string, notifications: unknown[]) {
  return makeNotificationsResponse(
    notifications,
    {
      generated_at: '2025-01-05T12:00:00Z',
      authenticity_token: TEST_ACTION_TOKENS.archive,
    },
    repo
  );
}

async function openDefaultProfileWithNotifications(page: Page) {
  await mockDefaultApiRoutes(page);
  const seenQueries = await mockQueryNotifications(page, {
    'org:pytorch': queryResponse('pytorch/pytorch', pytorchNotifications),
    'org:meta-pytorch': queryResponse('meta-pytorch/test', metaPytorchNotifications),
  });

  await page.goto('notifications.html');
  await clearAppStorage(page);
  await expect(page.locator('#profile-select')).toHaveValue('pytorch');
  await expect(page.locator('#repo-input')).toHaveValue(DEFAULT_PROFILE_INPUT);

  await page.locator('#sync-btn').click();

  await expect(page.locator('#status-bar')).toContainText(
    `Synced ${allNotifications.length} notifications`
  );
  await expect(page.locator('.notification-item')).toHaveCount(allNotifications.length);
  await expect(page.locator('#comment-cache-status')).toHaveText(
    `Comments cached: ${allNotifications.length}`
  );
  expect(seenQueries).toEqual(QUERY_ORDER);
}

test.describe('Multi-profile actions @mutation', () => {
  test('bulk mark selected as done uses each notification repo and undo restores', async ({
    page,
  }) => {
    await openDefaultProfileWithNotifications(page);
    const actions = await captureHtmlActions(page);
    const watermarkUrls: string[] = [];

    await page.route('**/notifications/html/repo/**/read-comment-watermarks/**', (route) => {
      watermarkUrls.push(new URL(route.request().url()).pathname);
      return fulfillJson(route, { status: 'ok' });
    });

    await page.locator('[data-id="pt-bulk"] .notification-checkbox').click();
    await page.locator('[data-id="meta-bulk"] .notification-checkbox').click();
    await expect(page.locator('#mark-done-btn')).toHaveText('Mark selected as done');

    await page.locator('#mark-done-btn').click();

    await expect(page.locator('#status-bar')).toContainText('Done 2/2 (0 pending)');
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'archive',
        notification_ids: ['pt-bulk', 'meta-bulk'],
      }),
    ]);
    expect(watermarkUrls.sort()).toEqual([
      '/notifications/html/repo/meta-pytorch/test/read-comment-watermarks/meta-bulk',
      '/notifications/html/repo/pytorch/pytorch/read-comment-watermarks/pt-bulk',
    ]);

    await page.keyboard.press('u');

    await expect(page.locator('#status-bar')).toContainText('Undo successful');
    await expect(page.locator('[data-id="pt-bulk"]')).toBeVisible();
    await expect(page.locator('[data-id="meta-bulk"]')).toBeVisible();
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'archive',
        notification_ids: ['pt-bulk', 'meta-bulk'],
      }),
      expect.objectContaining({
        action: 'unarchive',
        notification_ids: ['pt-bulk', 'meta-bulk'],
      }),
    ]);
  });

  test('inline unsubscribe works from the default query profile', async ({ page }) => {
    await openDefaultProfileWithNotifications(page);
    const actions = await captureHtmlActions(page);

    await page
      .locator('[data-id="pt-unsub"] .notification-actions-inline .notification-unsubscribe-btn')
      .click();

    await expect(page.locator('[data-id="pt-unsub"]')).not.toBeAttached();
    await expect
      .poll(() => actions.filter((action) => action.action === 'unsubscribe'))
      .toEqual([
        expect.objectContaining({
          notification_ids: ['pt-unsub'],
        }),
      ]);
  });

  test('bookmark toggle writes local state to the notification repo', async ({ page }) => {
    await openDefaultProfileWithNotifications(page);
    const bookmarkUrls: string[] = [];

    await page.route('**/notifications/html/repo/**/bookmarks/**', (route) => {
      bookmarkUrls.push(new URL(route.request().url()).pathname);
      return fulfillJson(route, { status: 'ok', bookmarked: true });
    });

    await page
      .locator('[data-id="meta-bookmark"] .notification-actions-inline .notification-bookmark-btn')
      .click();

    await expect(page.locator('#status-bar')).toContainText('Bookmarked');
    await expect.poll(() => bookmarkUrls.slice()).toEqual([
      '/notifications/html/repo/meta-pytorch/test/bookmarks/meta-bookmark',
    ]);
  });
});
