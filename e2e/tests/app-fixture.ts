import { expect, type Page, type Route } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import {
  addAuthCacheInitScript,
  APP_STORAGE_KEYS,
  clearAppStorage,
  seedAuthCache,
  seedCommentCache,
  seedNotificationsCache,
  seedRepoSelection,
} from './storage-utils';

type JsonBody = unknown;
type RouteHandler = Parameters<Page['route']>[1];

const DEFAULT_REPO = 'test/repo';
const DEFAULT_LOGIN = 'testuser';

function fulfillJson(route: Route, body: JsonBody, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function notificationsArray(payload: JsonBody) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && 'notifications' in payload) {
    const notifications = (payload as { notifications?: unknown }).notifications;
    if (Array.isArray(notifications)) {
      return notifications;
    }
  }
  return [];
}

export const testIds = {
  notification: (id: string) => `[data-id="${id}"]`,
  notificationCheckbox: (id: string) => `[data-id="${id}"] .notification-checkbox`,
};

export function viewTab(page: Page, view: 'issues' | 'pr-notifications' | 'others-prs' | 'cleaned') {
  return page.locator(`#view-${view}`);
}

export function subfilterTab(
  page: Page,
  view: 'issues' | 'pr-notifications' | 'others-prs' | 'cleaned',
  subfilter: string,
  group?: 'state' | 'author' | 'interest'
) {
  const groupSelector = group ? `[data-subfilter-group="${group}"]` : '';
  return page
    .locator(`.subfilter-tabs[data-for-view="${view}"]${groupSelector}`)
    .locator(`[data-subfilter="${subfilter}"]`);
}

export async function mockDefaultApiRoutes(page: Page, options: {
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const login = options.login ?? DEFAULT_LOGIN;
  const notifications = options.notifications ?? mixedFixture;
  const repo = options.repo ?? DEFAULT_REPO;
  const [owner, name] = repo.split('/');

  await page.route('**/github/rest/user', (route) => fulfillJson(route, { login }));
  await page.route('**/github/rest/rate_limit', (route) =>
    fulfillJson(route, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
        graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
      },
    })
  );
  await page.route('**/notifications/html/repo/**', (route) => fulfillJson(route, notifications));
  await page.route('**/github/graphql', (route) => fulfillJson(route, { data: { repository: {} } }));
  await page.route('**/github/rest/repos/**/issues/**/comments**', (route) => fulfillJson(route, []));
  await page.route('**/github/rest/repos/**/issues/**', (route) => {
    if (route.request().url().includes('/comments')) {
      return route.fallback();
    }
    return fulfillJson(route, { id: 1, body: '', user: { login } });
  });
  await page.route(`**/api/snapshots/${owner}/${name}`, (route) => fulfillJson(route, { snapshot: null }));
}

export async function mockHtmlAction(
  page: Page,
  body: JsonBody = { status: 'ok' },
  options: { status?: number } = {}
) {
  await page.route('**/notifications/html/action', (route) =>
    fulfillJson(route, body, options.status ?? 200)
  );
}

export async function replaceHtmlAction(page: Page, handler: RouteHandler) {
  await page.unroute('**/notifications/html/action').catch(() => undefined);
  await page.route('**/notifications/html/action', handler);
}

export async function openNotificationsApp(page: Page, options: {
  login?: string;
  repo?: string;
} = {}) {
  const login = options.login ?? DEFAULT_LOGIN;
  const repo = options.repo ?? DEFAULT_REPO;

  await addAuthCacheInitScript(page, login);
  await page.addInitScript(
    ({ repoKey, repoValue }) => {
      localStorage.setItem(repoKey, repoValue);
    },
    { repoKey: APP_STORAGE_KEYS.repo, repoValue: repo }
  );
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
}

export async function syncNotifications(page: Page, options: {
  expectedCount?: number;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await page.locator('#repo-input').fill(repo);
  await page.locator('#sync-btn').click();
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
}

export async function openNotificationsWithSync(page: Page, options: {
  expectedCount?: number;
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await mockDefaultApiRoutes(page, options);
  await openNotificationsApp(page, options);
  await clearAppStorage(page);
  await syncNotifications(page, { expectedCount, repo });
}

export async function openNotificationsWithCachedData(page: Page, options: {
  commentCache?: JsonBody;
  expectedCount?: number;
  login?: string;
  notifications?: JsonBody;
  repo?: string;
} = {}) {
  const expectedCount = options.expectedCount ?? 4;
  const repo = options.repo ?? DEFAULT_REPO;

  await mockDefaultApiRoutes(page, options);
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
  await clearAppStorage(page);
  await seedAuthCache(page, options.login ?? DEFAULT_LOGIN);
  await seedRepoSelection(page, repo, { lastSynced: true });
  if (options.commentCache !== undefined) {
    await seedCommentCache(page, options.commentCache);
  }
  await seedNotificationsCache(page, notificationsArray(options.notifications ?? mixedFixture));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
}

export async function expectVisibleNotificationIds(page: Page, ids: string[]) {
  await expect(page.locator('.notification-item')).toHaveCount(ids.length);
  for (const id of ids) {
    await expect(page.locator(testIds.notification(id))).toBeVisible();
  }
}

export async function expectHiddenNotificationIds(page: Page, ids: string[]) {
  for (const id of ids) {
    await expect(page.locator(testIds.notification(id))).not.toBeAttached();
  }
}

export async function selectNotification(page: Page, id: string, options: { shift?: boolean } = {}) {
  await page.locator(testIds.notificationCheckbox(id)).click({
    modifiers: options.shift ? ['Shift'] : undefined,
  });
}

export async function expectSelectionCount(page: Page, text: string) {
  await expect(page.locator('#selection-count')).toHaveText(text);
}
