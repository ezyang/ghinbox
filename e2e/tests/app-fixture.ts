import { expect, type Page, type Route } from '@playwright/test';
import mixedFixture from '../fixtures/notifications_mixed.json';
import { clearAppStorage, seedCommentCache, seedNotificationsCache } from './storage-utils';

type JsonBody = unknown;

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

export async function openNotificationsApp(page: Page, options: {
  login?: string;
  repo?: string;
} = {}) {
  const login = options.login ?? DEFAULT_LOGIN;
  const repo = options.repo ?? DEFAULT_REPO;

  await page.addInitScript(
    ({ loginValue, repoValue }) => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login: loginValue, timestamp: Date.now() })
      );
      localStorage.setItem('ghnotif_repo', repoValue);
    },
    { loginValue: login, repoValue: repo }
  );
  await page.goto('notifications.html', { waitUntil: 'domcontentloaded' });
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
  await page.locator('#repo-input').fill(repo);
  await page.locator('#sync-btn').click();
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
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
  await page.evaluate(
    ({ login, repoValue }) => {
      localStorage.setItem(
        'ghnotif_auth_cache',
        JSON.stringify({ login, timestamp: Date.now() })
      );
      localStorage.setItem('ghnotif_repo', repoValue);
      localStorage.setItem('ghnotif_last_synced_repo', repoValue);
    },
    { login: options.login ?? DEFAULT_LOGIN, repoValue: repo }
  );
  if (options.commentCache !== undefined) {
    await seedCommentCache(page, options.commentCache);
  }
  await seedNotificationsCache(page, notificationsArray(options.notifications ?? mixedFixture));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.notification-item')).toHaveCount(expectedCount);
}
